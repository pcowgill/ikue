'use strict';

var chai = require('chai'); // assertion library
var expect = chai.expect;
var assert = chai.assert;
var should = chai.should;
var sinon = require('sinon');
var vasync = require('vasync');
var _ = require('lodash');
var sinonChai = require("sinon-chai");
chai.use(sinonChai);

var WorkQueue = require('../lib/work_queue');

var RabbitManager = require('./lib/rabbitmq_manager');

var TestHelper = require('./lib/test_helper');


var TEST_VHOST = process.env.TEST_VHOST || 'test-vhost';

var amqpManager = new RabbitManager({
  url: 'http://localhost:15672/api/',
  http: {
    username: 'guest',
    password: 'guest',
  }
});

var currentVhost; 
var EventBus = require('../lib/event_bus');
var app1Bus;
var app2Bus;

var workQueue1;
var workQueue2;

// Remove existing vhost and re-create it
function resetVhost(done){
  vasync.waterfall([
    function(callback){
      amqpManager.removeVhost(TEST_VHOST, callback)
    },

    function(vhost, callback){
      amqpManager.createVhost(TEST_VHOST, function(err, vhost){
        // Asign the vhost so we can use it later
        currentVhost = vhost;

        callback(err, vhost);
      })
    }
  ], function(err, results){
    done(err);
  });
}

/**
  This function connect a work queue and call done when the work queue is ready
*/
function connectWorkQueue(queue, done){

  queue.once('ready', function(){
    done();
  });

  queue.once('error', function(err){
    done(err);
  });

  queue.start();
}


// This a default thest that we add here just in order to thes that
// "mocha" and "should" are installed correctly
describe('RabbitMq Manager', function () {

  afterEach(function(){
    workQueue1.connection.disconnect();
    workQueue2.connection.disconnect();
  });

  beforeEach(function(done){

    app1Bus = new EventBus("App1 Bus");
    app2Bus = new EventBus("App2 Bus");

    workQueue1 = new WorkQueue(app1Bus, {
      component: 'App1', 
      amqp: {
        url: "amqp://guest:guest@localhost:5672/"+TEST_VHOST
      }
    });

    workQueue2 = new WorkQueue(app2Bus,  {
      component: 'App2', 
      amqp: {
        url: "amqp://guest:guest@localhost:5672/"+TEST_VHOST
      }
    });

    // Reset/create a vhost for out tests
    vasync.pipeline({
      'funcs': [
        function(_, callback){
          resetVhost(callback)
        },

        // Connect all work queues
        function(_, callback){
          vasync.forEachParallel({
            'func': connectWorkQueue,
            'inputs': [ workQueue1, workQueue2]
          }, function (err, results) {
            callback(err, results);
          });
        }
      ]
    }, function(err, results){
      done(err);
    });

  });

  describe('Basic Work Queue feature', function(){

    var job;

    beforeEach(function(){
      job = workQueue1.createJob('say_hello', {name: "Diallo"});
    });

    it('When a component push a work, all the appropriate meta data should be set', 
      function(done){
        job
          .maxRetry(4)
          .delay(5000)
          .backoff('exponential')
          .priority('low')
          .send();

        TestHelper.waitForJobWithId(job.id, workQueue1, function(err, jobs){
          var headers = jobs[0].headers;

          expect(jobs).to.have.length(1);
          expect(jobs[0].headers.jobId).to.be.eql(job.id);

          expect(headers.worker_id).to.be.eql('say_hello');

          expect(headers.backoff).to.be.eql('exponential');
          expect(headers.priority).to.be.eql(10);
          expect(headers.delay).to.be.eql(5000);
          expect(headers.max_attempts).to.be.eql(4);
          expect(headers.made_attempts).to.be.eql(0);

          done(err);
        });
    });

    it('When a component push a work, all work queue of the app should receive it', 
      function(done){
        job.send();

        TestHelper.waitForJobWithId(job.id, [workQueue1, workQueue2], function(err, jobs){

          expect(jobs).to.have.length(2);
          expect(jobs[0].headers.jobId).to.be.eql(job.id);
          expect(jobs[1].headers.jobId).to.be.eql(job.id);

          expect(jobs[0].headers.worker_id).to.be.eql('say_hello');
          expect(jobs[0].headers.worker_id).to.be.eql('say_hello');

          done(err);
        });
    });

    it('When a component push a work, and the message queue is not connected, an error is returned', 
      function(done){

        workQueue1.connection.disconnect();

        workQueue1.connection.once('close', function(hadError){
          setImmediate(function(){
            job.send(function(err){
              expect(err+"").to.have.string('amqp client is not currently');
              done();
            });
          });
        });
    });

    it('When a component push a works, receive callback for each work request', 
      function(done){
        var job2 = workQueue2.createJob('say_hello2', {name: "Diallo"});
        var onSentSpy = sinon.spy();

        var calledCount = 0;

        job.send(onSentSpy);
        job2.send(onSentSpy);

        setTimeout(function(){
          expect(onSentSpy).to.have.been.calledTwice;
          done()
        }, 20);
    });

    it('If a job execution fail, it should be re-scheduled', 
      function(done){
        
        // Wait for the job and fail
        workQueue1.eventBus.on("say_hello", function(params, done2){
          done2(new Error('Failing on purpose'));
        });

        // Now submit the job
        job
          .delay(50000)
          .maxRetry(5).send();

        // Wait few moment and verify that the job have been rescheduled
        // We verify that by polling the wait queue
        setTimeout(function(){
          currentVhost.getQueueContents(workQueue1.waitQueueName, function(err, messages){
            _.each(messages, function(msg){

              if (msg.properties.headers.jobId == job.id) {
                // We found the job in the wait queue
                // Now verify that it has the right ttl

                expect(msg.properties.expiration).to.be.eql(job.delay()+'');
                expect(msg.properties.headers.delay).to.be.eql(job.delay());
                expect(msg.properties.headers.priority).to.be.eql(job.priority());
                expect(msg.properties.headers.backoff).to.be.eql(job.backoff());
                expect(msg.properties.headers.worker_id).to.be.eql('say_hello');
                expect(msg.properties.headers.max_attempts).to.be.eql(5);
                expect(msg.properties.headers.made_attempts).to.be.eql(1);

                done();
              }
            });
          });
        }, 20);

    });

  it('If a job execution fail, it should be re-tried as configured and only on the failing worker', 
      function(done){
        
        var failingWorker = sinon.spy(function(params, done2){
          done2(new Error('Failling on purpose2'));
        });

        var onNewMessageSpy = sinon.spy();

        var onNewMessageQueue2 = sinon.spy(function(params, done){
          done();
        });

        // Wait for the job and fail
        workQueue1.eventBus.on("say_hello", failingWorker);
        workQueue1.on('new_work', onNewMessageSpy);

        workQueue2.eventBus.on("say_hello", onNewMessageQueue2);

        // Now submit the job
        job
          .delay(1)
          .maxRetry(3).send();

        // Wait few moment and verify that the job have been rescheduled
        // We verify that by polling the wait queue
        setTimeout(function(){

          // Should have called the worker once for every retry
          expect(failingWorker).to.have.been.callCount(4);
          expect(onNewMessageSpy).to.have.been.callCount(4);

          // The retry should have reached the other worker once because it succeed
          expect(onNewMessageQueue2).to.have.been.callCount(1)
          

          var lastCallCallArgs = onNewMessageSpy.lastCall.args;

          var headers = lastCallCallArgs[0].headers;

          expect(headers.delay).to.be.eql(job.delay());
          expect(headers.priority).to.be.eql(job.priority());
          expect(headers.backoff).to.be.eql(job.backoff());
          expect(headers.worker_id).to.be.eql('say_hello');
          expect(headers.max_attempts).to.be.eql(3);
          expect(headers.made_attempts).to.be.eql(3);

          currentVhost.getQueueContents(workQueue1.failedQueueName, function(err, messages){

            var msg = messages.pop();
            expect(msg).to.exist();
            expect(msg.properties.headers.jobId).to.be.eql(job.id);

            done();
          });

        }, 30);

    });

  });

});