/*\
title: test-plugin-library-server.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Tests for the TiddlyWeb-compatible in-iframe plugin library server in
$:/plugins/tiddlywiki/pluginlibrary/libraryserver.js.

The server is a browser script (it uses window/XMLHttpRequest) so it is executed
in a sandbox that provides minimal browser globals. These checks cover:

* the "ready" announcement that lets the host settle the iframe even when the
  iframe load event never fires
* the GET / GET-RESPONSE routes for the asset list and individual tiddlers
* the error path of the tiddler JSON fetch, which previously hung silently
  because the XHR callback was only ever invoked on HTTP 200

\*/

"use strict";

if($tw.node) {

	describe("plugin library server (libraryserver.js)",function() {

		var vm = require("vm"),
			path = require("path"),
			fs = require("fs");

		var librarySource;

		beforeAll(function() {
		// The plugin lives outside the test edition tiddler store; read it directly
			var candidates = [
				path.resolve(process.cwd(),"plugins/tiddlywiki/pluginlibrary/libraryserver.js"),
				path.resolve($tw.boot.wikiPath,"plugins/tiddlywiki/pluginlibrary/libraryserver.js"),
				path.resolve($tw.boot.wikiPath,"../../plugins/tiddlywiki/pluginlibrary/libraryserver.js")
			];
			var existing = candidates.filter(function(candidate) { return fs.existsSync(candidate); });
			if(existing.length === 0) {
				throw new Error("Could not locate pluginlibrary/libraryserver.js from " + $tw.boot.wikiPath);
			}
			librarySource = fs.readFileSync(existing[0],"utf8");
		});

		// Build a fresh sandbox per test. xhrBehaviour lets each test script the
		// XMLHttpRequest used for individual tiddler fetches.
		function startServer(options) {
			options = options || {};
			var postedToHost = [],
				messageListener = null,
				intervalJobs = [],
				timeoutJobs = [],
				xhrInstances = [];
			var fakeParent = {
				postMessage: function(message,origin) {
					postedToHost.push(message);
				}
			};
			function FakeXMLHttpRequest() {
				var self = this;
				this.headers = {};
				this.method = null;
				this.url = null;
				this.readyState = 0;
				this.status = 0;
				this.responseText = null;
				xhrInstances.push(this);
				this.open = function(method,url) {
					self.method = method;
					self.url = url;
				};
				this.setRequestHeader = function(name,value) {
					self.headers[name] = value;
				};
				this.send = function() {
					if(options.xhrBehaviour) {
						options.xhrBehaviour(self);
					}
				};
				this.abort = function() {};
			}
			var sandbox = {
				console: console,
				setInterval: function(fn,delay) {
					var id = intervalJobs.length + 1;
					intervalJobs.push({id: id, fn: fn});
					return id;
				},
				clearInterval: function(id) {
					intervalJobs = intervalJobs.filter(function(job) { return job.id !== id; });
				},
				setTimeout: function(fn,delay) {
					timeoutJobs.push(fn);
					return timeoutJobs.length;
				},
				clearTimeout: function() {},
				XMLHttpRequest: FakeXMLHttpRequest,
				assetList: options.assetList || [
					{title: "$:/plugins/test/one", name: "One", type: "application/json", "plugin-type": "plugin"}
				]
			};
			sandbox.window = sandbox;
			sandbox.parent = fakeParent;
			sandbox.opener = null;
			sandbox.addEventListener = function(type,listener) {
				if(type === "message") {
					messageListener = listener;
				}
			};
			vm.createContext(sandbox);
			vm.runInContext(librarySource,sandbox,{filename: "libraryserver.js"});
			return {
				sandbox: sandbox,
				postedToHost: postedToHost,
				xhrInstances: xhrInstances,
				// Send a GET as the host would
				get: function(url,cookies,sourceWindow) {
					var responses = [];
					var source = sourceWindow || {
						postMessage: function(message) { responses.push(message); }
					};
					messageListener({
						data: {verb: "GET", url: url, cookies: cookies || {type: "save-tiddler", url: "http://example.com"}},
						source: source,
						origin: "http://example.com"
					});
					return responses;
				},
				// Latest source from the most recent GET (for async XHR responses)
				lastResponses: function(sourceWindow) {
				// no-op kept for clarity
					return sourceWindow;
				},
				runReadyRetries: function(count) {
					var jobs = intervalJobs.slice(0);
					jobs.forEach(function(job) {
						for(var t = 0; t < count; t++) {
							job.fn();
						}
					});
				},
				getListener: function() { return messageListener; }
			};
		}

		it("announces ready to the parent as soon as the listener is bound",function() {
			var server = startServer();
			expect(server.postedToHost.length).toBeGreaterThan(0);
			expect(server.postedToHost[0].verb).toBe("ready");
			// Retries continue for late-attaching hosts
			var before = server.postedToHost.length;
			server.runReadyRetries(1);
			expect(server.postedToHost.length).toBe(before + 1);
		});

		it("returns the asset list for recipes/library/tiddlers.json",function() {
			var server = startServer({assetList: [{title: "a"}, {title: "b"}]});
			var responses = server.get("recipes/library/tiddlers.json",{type: "save-info", url: "http://example.com"});
			expect(responses.length).toBe(1);
			expect(responses[0].verb).toBe("GET-RESPONSE");
			expect(responses[0].status).toBe("200");
			expect(responses[0].cookies.type).toBe("save-info");
			var body = JSON.parse(responses[0].body);
			expect(body.length).toBe(2);
			expect(body[0].title).toBe("a");
		});

		it("fetches an individual tiddler and replies 200 with its body",function() {
			var server = startServer();
			var source = {received: [], postMessage: function(m) { this.received.push(m); }};
			server.get("recipes/library/tiddlers/" + encodeURIComponent("$:/plugins/test/one") + ".json",
				{type: "save-tiddler", url: "http://example.com"}, source);
			expect(server.xhrInstances.length).toBe(1);
			var xhr = server.xhrInstances[0];
			expect(xhr.method).toBe("GET");
			// The route segment the host sends is already encoded; the server
			// encodes it again to obtain the on-disk filename (pre-existing contract)
			expect(xhr.url).toBe("recipes/library/tiddlers/" + encodeURIComponent(encodeURIComponent("$:/plugins/test/one")) + ".json");
			xhr.readyState = 4;
			xhr.status = 200;
			xhr.responseText = JSON.stringify({title: "$:/plugins/test/one"});
			xhr.onreadystatechange();
			expect(source.received.length).toBe(1);
			expect(source.received[0].status).toBe("200");
			expect(JSON.parse(source.received[0].body).title).toBe("$:/plugins/test/one");
		});

		it("replies 404 when the tiddler XHR fails instead of hanging",function() {
			var server = startServer();
			var source = {received: [], postMessage: function(m) { this.received.push(m); }};
			server.get("recipes/library/tiddlers/" + encodeURIComponent("missing") + ".json",
				{type: "save-tiddler", url: "http://example.com"}, source);
			var xhr = server.xhrInstances[0];
			// Network error / abort (the old implementation never invoked any callback)
			xhr.onerror();
			expect(source.received.length).toBe(1);
			expect(source.received[0].status).toBe("404");
			// The callback must only complete once
			xhr.onabort();
			xhr.readyState = 4;
			xhr.status = 200;
			xhr.responseText = "{}";
			xhr.onreadystatechange();
			expect(source.received.length).toBe(1);
		});

		it("replies 404 for a non-200 HTTP status",function() {
			var server = startServer();
			var source = {received: [], postMessage: function(m) { this.received.push(m); }};
			server.get("recipes/library/tiddlers/missing.json",{type: "save-tiddler", url: "u"},source);
			var xhr = server.xhrInstances[0];
			xhr.readyState = 4;
			xhr.status = 500;
			xhr.onreadystatechange();
			expect(source.received.length).toBe(1);
			expect(source.received[0].status).toBe("404");
		});

		it("replies 404 for unknown routes",function() {
			var server = startServer();
			var responses = server.get("bags/random/tiddlers.json",{type: "save-tiddler", url: "u"});
			expect(responses.length).toBe(1);
			expect(responses[0].status).toBe("404");
		});

		it("ignores messages that are not protocol objects",function() {
			var server = startServer();
			expect(function() {
				server.getListener()({data: "string message", source: {postMessage: function() {}}});
				server.getListener()({data: null, source: {postMessage: function() {}}});
			}).not.toThrow();
		});
	});

}
