/* global suite, test */

//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
const assert = require('assert');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const useMockery = require('../helpers/mockery');
const counter = require('../helpers/counter');
const fixtures = require('../fixtures/general');

const Queue = require('../mocks/lib/Queue');

// Defines a Mocha test suite to group tests of similar kind together
describe('Push', function() {
	let Push, push;

	useMockery(() => {
		useMockery
			.registerMultiple({
				'vscode': require('../mocks/node/vscode'),
				'./lib/ServiceSettings': require('../mocks/lib/ServiceSettings').sftp,
				'./lib/Service': require('../mocks/lib/Service'),
				'./lib/explorer/Explorer': require('../mocks/lib/Explorer'),
				// './lib/Paths': require('../mocks/lib/Paths'),
				'./lib/queue/Queue': Queue,
				// './lib/queue/QueueTask': {},
				'./lib/Watch': require('../mocks/lib/Watch'),
				'./lib/SCM': require('../mocks/lib/SCM'),
				'./lib/channel': require('../mocks/lib/channel'),
				'./lib/utils': require('../mocks/lib/utils'),
				'./lib/PushBase': require('../mocks/lib/PushBase'),
				'./lang/i18n': require('../mocks/lib/i18n')
			});
	});

	before(() => {
		Push = require('../../src/Push');
		Push.globals.FORCE_STOP_TIMEOUT = 2;
	});

	beforeEach(() => {
		push = new Push();
		counter.reset();
	});

	// Defines a Mocha unit test
	describe('#didSaveTextDocument', () => {
		it('returns when textDocument has no uri', () => {
			assert(push.didSaveTextDocument({}) === false);
		});

		it('returns when textDocument uri scheme is not valid', () => {
			assert(push.didSaveTextDocument({
				scheme: 'notfile'
			}) === false);
		});

		it('runs queueForUpload when textDocument uri is valid', () => {
			push.queueForUpload = counter.replace(
				'Push#queueForUpload',
				push.queueForUpload,
				() => Promise.resolve()
			);

			push.didSaveTextDocument({
				uri: fixtures.mockUriFile
			});

			assert(counter.getCount('Push#queueForUpload') === 1);
		});
	});

	describe('#queue', () => {
		it('adds an initial function to a new queue', () => {
			push.queue([() => {}]);
			assert(push.queues[Push.queueDefs.default.id].tasks.length === 2);
		});

		it('should not add an initial function to a running queue', () => {
			const queue = push.getQueue(Push.queueDefs.default);

			queue.running = true;
			push.queue([() => { }]);

			assert(push.queues[Push.queueDefs.default.id].tasks.length === 1);
		});

		it('runs the queue immediately when required', () => {
			push.execQueue = counter.create('Push#execQueue', push.execQueue);
			push.queue([() => { }], true);

			assert(counter.getCount('Push#execQueue') === 1);
		});
	});

	describe('#queueForUpload', () => {
		it('queues a single Uri for uploading', () => {
			return push.queueForUpload(fixtures.mockUriFile)
				.then(() => {
					assert(push.queues[Push.queueDefs.upload.id].tasks.length === 2);
				});
		});

		it('queues Uris for uploading', () => {
			return push.queueForUpload([fixtures.mockUriFile, fixtures.mockUriFile2])
				.then(() => {
					assert(push.queues[Push.queueDefs.upload.id].tasks.length === 3);
				});
		});
	});

	describe('#execUploadQueue', () => {
		it('executes a queue with >0 items', () => {
			push.execQueue = counter.replace('Push#execQueue', push.execQueue, () => {
				return Promise.resolve();
			});

			return push.queueForUpload(fixtures.mockUriFile)
				.then(() => {
					return push.execUploadQueue();
				})
				.then(() => {
					assert(counter.getCount('Push#execQueue') === 1);
				});
		});

		it('writes channel info if queueing is disabled', () => {
			return push.queueForUpload(fixtures.mockUriFile)
				.catch(() => {
					push.config.uploadQueue = false;
					push.execUploadQueue();

					assert(
						counter.getArgs('Channel#appendLocalisedInfo', 1, 0) ===
						'upload_queue_disabled'
					);
				});
		});

		it('shows a warning if queue is empty', () => {
			return push.queueForUpload(fixtures.mockUriFile)
				.catch(() => {
					push.execUploadQueue();

					assert(
						counter.getArgs('utils.showWarning', 1, 0) ===
						'queue_empty'
					)
				});
		});
	});

	describe('#getQueue', () => {
		it('throws without a valid queue', () => {
			assert.throws(() => {
				push.getQueue({});
			});

			assert.throws(() => {
				push.getQueue();
			});
		});

		it('returns a new queue if it doesn\'t exist', () => {
			assert(push.getQueue(fixtures.queueDefinitions.cancellable) instanceof Queue);
		});

		it('returns null if no new queue is desired', () => {
			assert(push.getQueue(fixtures.queueDefinitions.cancellable, false) === null);
		});

		it('returns a queue that exists', () => {
			return push.queueForUpload(fixtures.mockUriFile)
				.then(() => {
					const queue = push.getQueue(Push.queueDefs.upload, false);
					assert(queue instanceof Queue);
					assert(queue.id === 'upload');
				});
		});
	});

	describe('#execQueue', () => {
		it('executes a valid queue', () => {
			push.queue([() => { }]);

			push.execQueue(Push.queueDefs.default)
				.then(() => {
					assert(counter.getCount('Queue#exec') === 1);
				});
		});

		it('returns if a queue is running', () => {
			push.queue([() => { }]);

			return push.execQueue(Push.queueDefs.default)
				.catch((message) => {
					assert(message === 'Queue running.');
				});
		});
	});

	describe('#stopCancellableQueues', () => {
		it('stops all running queues that can be cancelled', () => {
			const cancellable = push.getQueue(Push.queueDefs.default),
				nonCancellable = push.getQueue(Push.queueDefs.upload);

			push.stopQueue = counter.create('Push#stopQueue');

			cancellable.running = true;
			nonCancellable.running = true;

			return push.stopCancellableQueues()
				.then(() => {
					assert(counter.getCount('Push#stopQueue') === 1);
				});
		});
	});

	describe('#stopQueue', () => {
		it('stops a queue', () => {
			const queue = push.getQueue(Push.queueDefs.default);

			queue.running = true;

			return push.stopQueue(Push.queueDefs.default)
				.then(() => {;
					assert(counter.getCount('Queue#stop') === 1);
					assert(
						counter.getArgs('Channel#appendLocalisedInfo', 1, 0) ===
						'queue_cancelled'
					);
				});
		});

		it('stops a queue silently', () => {
			const queue = push.getQueue(Push.queueDefs.default);

			queue.running = true;
			push.stopQueue(Push.queueDefs.default, false, true)
				.then(() => {
					assert(counter.getCount('Queue#stop') === 1);
					assert(counter.getCount('Channel#appendLocalisedInfo') === 0);
				});
		});

		it('force stops a queue after 2 seconds', function() {
			this.timeout(2500);
			const queue = push.getQueue(Push.queueDefs.default);

			queue.running = true;

			// Replace Push#service#stop with a promise that never resolves
			push.service.stop = () => new Promise(() => {});

			push.stopQueue(Push.queueDefs.default, true)
				.catch(() => {
					assert(
						counter.getCount('Service#restartServiceInstance') === 1
					);

					assert(
						counter.getArgs('Channel#appendError', 1, 0) ===
						'queue_force_stopped'
					);
				});

		});
	});

	describe('#transfer', () => {
		const tests = [{
				method: 'put',
				files: fixtures.mockUriFile
			}, {
				method: 'put',
				files: [fixtures.mockUriFile, fixtures.mockUriFile2]
			}, {
				method: 'get',
				files: fixtures.mockUriFile
			}, {
				method: 'get',
				files: [fixtures.mockUriFile, fixtures.mockUriFile2]
			}];

		beforeEach(() => {
			push.queue = counter.attach(
				'Push#queue',
				() => Promise.resolve(),
				push
			);
		});

		tests.forEach((test) => {
			it(`queues a ${test.method} for ${(Array.isArray(test.files) && test.files.length) || '1'} file(s)`, () => {
				return push.transfer(test.files, test.method)
					.then(() => {
						let args;

						if (Array.isArray(test.files)) {
							let args = counter.getArgs('Push#queue');

							assert(counter.getCount('Push#queue') === test.files.length);

							test.files.forEach((file, index) => {
								assert(args[index][0][0].method === test.method);
								assert.deepEqual(args[index][0][0].uriContext, file);
							});
						} else {
							args = counter.getArgs('Push#queue', 1, 0);

							assert(counter.getCount('Push#queue') === 1);
							assert(args[0].method === test.method);
							assert.deepEqual(args[0].uriContext, test.files);
						}
					});
			});
		});

		it('writes channel info if a file is not found', () => {
			return push.transfer([
				fixtures.mockUriMissingFile,
				fixtures.mockUriFile
			], 'put')
				.then(() => {
					assert(
						counter.getArgs('Channel#appendLocalisedError', 1, 0) ===
						'file_not_found'
					);
					assert(counter.getCount('Push#queue') === 1);
				});
		});

		it('writes channel info if a file is ignored', () => {
			return push.transfer([
				fixtures.mockUriIgnoredFile,
				fixtures.mockUriFile
			], 'put')
				.then(() => {
					assert(
						counter.getArgs('Channel#appendLocalisedError', 1, 0) ===
						'cannot_action_ignored_file'
					);
				});
		});

		it('processes all but the ignored file', () => {
			return push.transfer([
				fixtures.mockUriFile,
				fixtures.mockUriIgnoredFile,
				fixtures.mockUriFile2
			], 'put')
				.then(() => {
					let args = counter.getArgs('Push#queue');

					assert(args[0][0][0].method === 'put');
					assert.deepEqual(args[0][0][0].uriContext, fixtures.mockUriFile);

					assert(args[1][0][0].method === 'put');
					assert.deepEqual(args[1][0][0].uriContext, fixtures.mockUriFile2);
				});
		});

		it('ignores files not in the supported scheme', () => {
			return push.transfer([
				fixtures.mockForeignSchemeFile
			], 'put')
				.then(() => {
					assert(counter.getCount('Channel#appendLocalisedError') === 0);
					assert(counter.getCount('Push#transfer') === 0);
				});
		});

		it('throws if files is undefined', () => {
			assert.throws(() => {
				push.transfer();
			}, /No files defined/);
		});

		it('throws if a method is undefined', () => {
			assert.throws(() => {
				push.transfer(fixtures.mockUriFile);
			}, /Unknown method/);
		});

		it('throws if the method is not known', () => {
			assert.throws(() => {
				push.transfer(fixtures.mockUriFile, 'nomethod');
			}, /Unknown method/);
		});

		it('throws if a directory is provided', () => {
			assert.throws(() => {
				push.transfer(fixtures.mockUriFolder, 'put');
			}, /is a directory/);
		});
	});

	describe('#transferDirectory', () => {
		it('returns if the path is not a valid scheme');
		it('throws if the path is not a directory');
	})
});
