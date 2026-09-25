/*\
title: test-browser-messaging.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Tests for the plugin library iframe handling in
$:/core/modules/browser-messaging.js (host side of the GET/GET-RESPONSE
protocol) and $:/plugins/tiddlywiki/pluginlibrary/libraryserver.js (the
library side of the same protocol).

The host module is a browser startup module, so it is exercised here with a
mocked window and document installed into the module sandbox. The library
script is evaluated from its source file with a mocked window, so that the
READY/GET/GET-RESPONSE handshake can be tested end to end. These tests are
node-only: run them with `node editions/test/quick-test.js browser-messaging`.

\*/
"use strict";

if($tw.node) {

	var fs = require("fs"),
		path = require("path"),
		libraryServerSource = fs.readFileSync(path.resolve($tw.boot.bootPath,"../plugins/tiddlywiki/pluginlibrary/libraryserver.js"),"utf8");

	// Evaluate the library server source against a mocked window. Returns nothing; interactions are observed through the mocks
	function evalLibraryServer(mockWindow,mockXHR,assetList) {
		$tw.utils.evalSandboxed(libraryServerSource,{
			window: mockWindow,
			XMLHttpRequest: mockXHR || function() {},
			console: {log: function() {}},
			assetList: assetList || [],
			exports: {}
		},"libraryserver.js",true);
	}

	describe("browser-messaging: plugin library iframes", function() {

		var LIBRARY_URL = "https://example.com/library/index.html";
		var CONNECTION_TITLE = "$:/temp/ServerConnection/" + LIBRARY_URL;

		var messaging = require("$:/core/modules/browser-messaging.js");

		var mockWindow, mockDocument, rootWidget, alerts, iframes, savedGlobals, realRootWidget;

		// Create a mock iframe element that records the messages posted to its content window
		function makeMockIFrame() {
			var attributes = {};
			var iframe = {
				style: {},
				parentNode: null,
				postedMessages: [],
				setAttribute: function(name,value) {
					attributes[name] = value;
				},
				getAttribute: function(name) {
					return $tw.utils.hop(attributes,name) ? attributes[name] : null;
				}
			};
			Object.defineProperty(iframe,"src",{
				get: function() {
					return attributes.src;
				},
				set: function(value) {
					attributes.src = value;
				}
			});
			iframe.contentWindow = {
				postMessage: function(message,targetOrigin) {
					iframe.postedMessages.push(message);
				}
			};
			iframes.push(iframe);
			return iframe;
		}

		function makeMockDocument() {
			var body = {
				children: [],
				appendChild: function(node) {
					this.children.push(node);
					node.parentNode = this;
				},
				removeChild: function(node) {
					var index = this.children.indexOf(node);
					if(index !== -1) {
						this.children.splice(index,1);
					}
					node.parentNode = null;
				}
			};
			return {
				body: body,
				createElement: function(tag) {
					return makeMockIFrame();
				},
				getElementsByTagName: function(tag) {
					return body.children.slice();
				}
			};
		}

		function makeMockWindow() {
			var listeners = {};
			return {
				addEventListener: function(type,handler) {
					listeners[type] = listeners[type] || [];
					listeners[type].push(handler);
				},
				fireMessage: function(data,source) {
					$tw.utils.each(listeners.message || [],function(handler) {
						handler({data: data,source: source});
					});
				}
			};
		}

		function makeMockRootWidget() {
			var listeners = {};
			return {
				addEventListener: function(type,handler) {
					listeners[type] = listeners[type] || [];
					listeners[type].push(handler);
				},
				dispatchMessage: function(type,paramObject) {
					$tw.utils.each(listeners[type] || [],function(handler) {
						handler({type: type,paramObject: paramObject});
					});
				}
			};
		}

		beforeEach(function() {
			// Save the globals that are about to be mocked out
			savedGlobals = {};
			$tw.utils.each(["window","document","alert"],function(name) {
				savedGlobals[name] = {
					exists: name in $tw.utils.sandbox,
					value: $tw.utils.sandbox[name]
				};
			});
			realRootWidget = $tw.rootWidget;
			// Install the mocks
			iframes = [];
			alerts = [];
			mockWindow = makeMockWindow();
			mockDocument = makeMockDocument();
			rootWidget = makeMockRootWidget();
			$tw.utils.sandbox.window = mockWindow;
			$tw.utils.sandbox.document = mockDocument;
			$tw.utils.sandbox.alert = function(message) {
				alerts.push(message);
			};
			$tw.rootWidget = rootWidget;
			// Run the startup module against the mocks
			messaging.startup();
		});

		afterEach(function() {
			// Restore the real globals
			$tw.utils.each(["window","document","alert"],function(name) {
				if(savedGlobals[name].exists) {
					$tw.utils.sandbox[name] = savedGlobals[name].value;
				} else {
					delete $tw.utils.sandbox[name];
				}
			});
			$tw.rootWidget = realRootWidget;
			// Remove the temporary tiddlers created by the module
			$tw.utils.each($tw.wiki.filterTiddlers("[prefix[$:/temp/ServerConnection/]] [prefix[$:/temp/RemoteAssetInfo/]]"),function(title) {
				$tw.wiki.deleteTiddler(title);
			});
		});

		it("should defer the first GET until the iframe onload event fires", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes.length).toBe(1);
			expect(iframes[0].postedMessages.length).toBe(0);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loading");
			iframes[0].onload();
			expect(iframes[0].postedMessages.length).toBe(1);
			expect(iframes[0].postedMessages[0].verb).toBe("GET");
			expect(iframes[0].postedMessages[0].url).toBe("recipes/library/tiddlers.json");
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loaded");
		});

		it("should trigger the first GET on a READY message even if the onload event never fires", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes[0].postedMessages.length).toBe(0);
			// The library script has run and announces itself, but the load event never fires
			mockWindow.fireMessage({verb: "READY"},iframes[0].contentWindow);
			expect(iframes[0].postedMessages.length).toBe(1);
			expect(iframes[0].postedMessages[0].verb).toBe("GET");
			expect(iframes[0].postedMessages[0].url).toBe("recipes/library/tiddlers.json");
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loaded");
		});

		it("should ignore READY messages that do not come from a known library iframe", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			mockWindow.fireMessage({verb: "READY"},{postMessage: function() {}});
			expect(iframes[0].postedMessages.length).toBe(0);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loading");
		});

		it("should queue callbacks registered while the iframe is still loading", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			// The second message must not reuse the iframe before it is ready
			expect(iframes.length).toBe(1);
			expect(iframes[0].postedMessages.length).toBe(0);
			iframes[0].onload();
			expect(iframes[0].postedMessages.length).toBe(2);
			expect(iframes[0].postedMessages[0].verb).toBe("GET");
			expect(iframes[0].postedMessages[1].verb).toBe("GET");
		});

		it("should queue tm-load-plugin-from-library while the iframe is still loading", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			rootWidget.dispatchMessage("tm-load-plugin-from-library",{url: LIBRARY_URL,title: "$:/plugins/example/demo"});
			expect(iframes[0].postedMessages.length).toBe(0);
			mockWindow.fireMessage({verb: "READY"},iframes[0].contentWindow);
			expect(iframes[0].postedMessages.length).toBe(2);
			expect(iframes[0].postedMessages[0].url).toBe("recipes/library/tiddlers.json");
			expect(iframes[0].postedMessages[1].url).toBe("recipes/library/tiddlers/" + encodeURIComponent("$:/plugins/example/demo") + ".json");
		});

		it("should reuse the iframe once the library is loaded", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			iframes[0].onload();
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes.length).toBe(1);
			expect(iframes[0].postedMessages.length).toBe(2);
		});

		it("should fail queued callbacks and record the error state when the iframe cannot be loaded", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			iframes[0].onerror();
			expect(alerts.length).toBe(2);
			expect(alerts[0].indexOf(LIBRARY_URL)).not.toBe(-1);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("error");
		});

		it("should retry with a fresh iframe after a failed load", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			iframes[0].onerror();
			expect(alerts.length).toBe(1);
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes.length).toBe(2);
			expect(iframes[0].parentNode).toBe(null);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loading");
			mockWindow.fireMessage({verb: "READY"},iframes[1].contentWindow);
			expect(iframes[1].postedMessages.length).toBe(1);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loaded");
		});

		it("should save plugin info tiddlers from GET-RESPONSE messages", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			iframes[0].onload();
			var getMessage = iframes[0].postedMessages[0];
			mockWindow.fireMessage({
				verb: "GET-RESPONSE",
				status: "200",
				cookies: getMessage.cookies,
				url: getMessage.url,
				type: "application/json",
				body: JSON.stringify([{title: "$:/plugins/example/demo",description: "Demo plugin",tags: ["demo"],"plugin-type": "plugin"}])
			},iframes[0].contentWindow);
			var infoTitle = "$:/temp/RemoteAssetInfo/" + LIBRARY_URL + "/$:/plugins/example/demo",
				tiddler = $tw.wiki.getTiddler(infoTitle);
			expect(!!tiddler).toBe(true);
			expect(tiddler.fields["original-title"]).toBe("$:/plugins/example/demo");
			expect(tiddler.fields["server-url"]).toBe(LIBRARY_URL);
			expect(tiddler.fields["original-plugin-type"]).toBe("plugin");
		});

		it("should unload the library iframe on tm-unload-plugin-library", function() {
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			iframes[0].onload();
			rootWidget.dispatchMessage("tm-unload-plugin-library",{url: LIBRARY_URL});
			expect(iframes[0].parentNode).toBe(null);
			expect($tw.wiki.tiddlerExists(CONNECTION_TITLE)).toBe(false);
			// Loading the library again creates a fresh iframe
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes.length).toBe(2);
		});

		it("should complete the READY/GET/GET-RESPONSE handshake with a real library server instance", function() {
			// Open the plugin library; the onload event never fires
			rootWidget.dispatchMessage("tm-load-plugin-library",{url: LIBRARY_URL});
			expect(iframes[0].postedMessages.length).toBe(0);
			// Run the library server in the iframe, wiring its window to the host mocks
			var libraryListeners = [],
				libraryWindow = {
					addEventListener: function(type,handler) {
						libraryListeners.push(handler);
					}
				};
			libraryWindow.parent = {
				postMessage: function(message) {
					// Messages to the parent arrive at the host window with the iframe content window as the source
					mockWindow.fireMessage(message,iframes[0].contentWindow);
				}
			};
			iframes[0].contentWindow.postMessage = function(message) {
				// Messages to the iframe arrive at the library server
				$tw.utils.each(libraryListeners,function(handler) {
					handler({data: message,source: {
						postMessage: function(reply) {
							mockWindow.fireMessage(reply,iframes[0].contentWindow);
						}
					}});
				});
			};
			evalLibraryServer(libraryWindow,null,[{title: "$:/plugins/example/demo",description: "Demo plugin"}]);
			// The library announced itself, so the host sent the first GET and processed the response
			var infoTitle = "$:/temp/RemoteAssetInfo/" + LIBRARY_URL + "/$:/plugins/example/demo",
				tiddler = $tw.wiki.getTiddler(infoTitle);
			expect($tw.wiki.getTiddlerText(CONNECTION_TITLE)).toBe("loaded");
			expect(!!tiddler).toBe(true);
			expect(tiddler.fields["original-title"]).toBe("$:/plugins/example/demo");
		});
	});

	describe("pluginlibrary: library server", function() {

		// Run the library server with a mocked window, returning the recorded interactions
		function runLibraryServer(options) {
			var messageListeners = [],
				xhrInstances = [],
				parentMessages = [],
				mockParent = {
					postMessage: function(message,targetOrigin) {
						parentMessages.push(message);
					}
				},
				mockWindow = {
					addEventListener: function(type,handler) {
						messageListeners.push(handler);
					}
				};
			mockWindow.parent = options.standalone ? mockWindow : mockParent;
			var MockXMLHttpRequest = function() {
				var self = this;
				this.open = function(method,url) {
					this.url = url;
				};
				this.send = function() {
					xhrInstances.push(self);
				};
			};
			evalLibraryServer(mockWindow,MockXMLHttpRequest,[{title: "$:/plugins/example/demo"}]);
			return {
				parentMessages: parentMessages,
				xhrInstances: xhrInstances,
				fireMessage: function(data,source) {
					$tw.utils.each(messageListeners,function(handler) {
						handler({data: data,source: source});
					});
				}
			};
		}

		function makeMockHostWindow() {
			return {
				postedMessages: [],
				postMessage: function(message) {
					this.postedMessages.push(message);
				}
			};
		}

		it("should announce READY to the host window when embedded in an iframe", function() {
			var server = runLibraryServer({standalone: false});
			expect(server.parentMessages.length).toBe(1);
			expect(server.parentMessages[0].verb).toBe("READY");
		});

		it("should not announce READY when opened standalone", function() {
			var server = runLibraryServer({standalone: true});
			expect(server.parentMessages.length).toBe(0);
		});

		it("should answer GET requests for the plugin list", function() {
			var server = runLibraryServer({standalone: false}),
				hostWindow = makeMockHostWindow();
			server.fireMessage({
				verb: "GET",
				url: "recipes/library/tiddlers.json",
				cookies: {type: "save-info",infoTitlePrefix: "$:/temp/RemoteAssetInfo/",url: "https://example.com/library/index.html"}
			},hostWindow);
			expect(hostWindow.postedMessages.length).toBe(1);
			expect(hostWindow.postedMessages[0].verb).toBe("GET-RESPONSE");
			expect(hostWindow.postedMessages[0].status).toBe("200");
			expect(JSON.parse(hostWindow.postedMessages[0].body)).toEqual([{title: "$:/plugins/example/demo"}]);
		});

		it("should answer GET requests for individual tiddlers over HTTP", function() {
			var server = runLibraryServer({standalone: false}),
				hostWindow = makeMockHostWindow();
			server.fireMessage({
				verb: "GET",
				url: "recipes/library/tiddlers/" + encodeURIComponent("$:/plugins/example/demo") + ".json",
				cookies: {type: "save-tiddler",url: "https://example.com/library/index.html"}
			},hostWindow);
			expect(server.xhrInstances.length).toBe(1);
			var xhr = server.xhrInstances[0];
			xhr.readyState = 4;
			xhr.status = 200;
			xhr.responseText = JSON.stringify({title: "$:/plugins/example/demo",text: "Demo"});
			xhr.onreadystatechange();
			expect(hostWindow.postedMessages.length).toBe(1);
			expect(hostWindow.postedMessages[0].verb).toBe("GET-RESPONSE");
			expect(hostWindow.postedMessages[0].status).toBe("200");
			expect(JSON.parse(hostWindow.postedMessages[0].body).title).toBe("$:/plugins/example/demo");
		});

		it("should answer with a 404 GET-RESPONSE when the HTTP fetch fails", function() {
			var server = runLibraryServer({standalone: false}),
				hostWindow = makeMockHostWindow();
			server.fireMessage({
				verb: "GET",
				url: "recipes/library/tiddlers/" + encodeURIComponent("$:/plugins/example/missing") + ".json",
				cookies: {type: "save-tiddler",url: "https://example.com/library/index.html"}
			},hostWindow);
			var xhr = server.xhrInstances[0];
			xhr.readyState = 4;
			xhr.status = 404;
			xhr.onreadystatechange();
			expect(hostWindow.postedMessages.length).toBe(1);
			expect(hostWindow.postedMessages[0].verb).toBe("GET-RESPONSE");
			expect(hostWindow.postedMessages[0].status).toBe("404");
		});
	});
}
