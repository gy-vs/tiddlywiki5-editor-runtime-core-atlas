/*\
title: test-browser-messaging.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Tests for the plugin library iframe host in $:/core/modules/browser-messaging.js.

Covers the behaviour where the iframe's load event may never fire even though the
library script inside it has already run and bound its message listener (for
example when subresource loading is interrupted), and where several callers
request the same library while it is still loading.

\*/

"use strict";

describe("browser-messaging: plugin library iframe",function() {

	if(!$tw.browser) {
		beforeAll(function() { pending("browser-only: requires DOM iframes and window messaging"); });
		return;
	}

	var iframeWindow,
		originalBrowserMessaging,
		messagesReceived,
		windowMessageListeners,
		rootListeners,
		originalAddEventListener,
		originalRootAddEventListener;

	beforeEach(function() {
		originalBrowserMessaging = $tw.browserMessaging;
		messagesReceived = [];
		windowMessageListeners = [];
		rootListeners = {};
		// Capture "message" listeners and root widget listeners so this run of
		// the startup module is isolated from any previous run (the module is
		// only executed once per page)
		originalAddEventListener = window.addEventListener;
		spyOn(window,"addEventListener").and.callFake(function(type,listener,useCapture) {
			if(type === "message") {
				windowMessageListeners.push(listener);
			} else {
				return originalAddEventListener.call(window,type,listener,useCapture);
			}
		});
		originalRootAddEventListener = $tw.rootWidget.addEventListener;
		$tw.rootWidget.addEventListener = function(type,listener) {
			(rootListeners[type] = rootListeners[type] || []).push(listener);
		};
		// A fake child window standing in for the iframe content window; it
		// records the GET messages the host posts after settling
		iframeWindow = {
			postMessage: function(message) {
				messagesReceived.push(message);
			}
		};
		// Run the startup module against the real DOM
		var startup = require("$:/core/modules/startup/browser-messaging.js");
		startup.startup();
		$tw.browserMessaging.readyTimeout = 60 * 1000; // Don't let the timer fire during these tests
		spyOn(window,"alert").and.stub();
	});

	afterEach(function() {
		var map = ($tw.browserMessaging && $tw.browserMessaging.iframeInfoMap) || {};
		$tw.utils.each(map,function(info) {
			if(info) {
				if(info.readyTimer !== null && info.readyTimer !== undefined) {
					window.clearTimeout(info.readyTimer);
				}
				if(info.domNode && info.domNode.parentNode) {
					info.domNode.parentNode.removeChild(info.domNode);
				}
			}
		});
		$tw.browserMessaging = originalBrowserMessaging;
		window.addEventListener = originalAddEventListener;
		$tw.rootWidget.addEventListener = originalRootAddEventListener;
		$tw.utils.each(
			$tw.wiki.filterTiddlers("[prefix[$:/temp/ServerConnection/]] [prefix[$:/temp/RemoteAssetInfo/]]"),
			function(title) { $tw.wiki.deleteTiddler(title); }
		);
	});

	function dispatchFromIFrame(data) {
		$tw.utils.each(windowMessageListeners,function(listener) {
			listener({data: data, source: iframeWindow, origin: "http://example.com"});
		});
	}

	function useFakeIFrameWindow(info) {
		info.domNode.contentWindow = iframeWindow;
	}

	// Drive the full tm-load-plugin-library data flow for a url
	function openLibrary(url) {
		$tw.utils.each(rootListeners["tm-load-plugin-library"],function(listener) {
			listener({type: "tm-load-plugin-library", paramObject: {url: url}});
		});
	}

	it("issues the first GET after a ready message when the load event never fires",function() {
		var url = "http://example.com/library-ready-only";
		openLibrary(url);
		var info = $tw.browserMessaging.iframeInfoMap[url];
		expect(info.status).toBe("loading");
		useFakeIFrameWindow(info);
		// Simulate the interrupted-load scenario: the library script ran and
		// announced ready, but the iframe load event never fires
		dispatchFromIFrame({verb: "ready"});
		expect(info.status).toBe("loaded");
		expect(messagesReceived.length).toBe(1);
		expect(messagesReceived[0].verb).toBe("GET");
		expect(messagesReceived[0].url).toBe("recipes/library/tiddlers.json");
		expect(messagesReceived[0].cookies.type).toBe("save-info");
	});

	it("delivers all callbacks for calls made while the iframe is loading",function() {
		var url = "http://example.com/library-queued",
			calls = [];
		openLibrary(url);
		// Second request while still loading must not invoke early nor be dropped
		openLibrary(url);
		$tw.browserMessaging.loadIFrame(url + "/direct",function() {}); // unrelated url stays separate
		var info = $tw.browserMessaging.iframeInfoMap[url];
		expect(info.pendingCallbacks.length).toBe(2);
		useFakeIFrameWindow(info);
		dispatchFromIFrame({verb: "ready"});
		expect(info.status).toBe("loaded");
		expect(messagesReceived.length).toBe(2); // both queued openers sent their GET
		// A further call on the ready iframe is served immediately
		$tw.browserMessaging.loadIFrame(url,function(err) { calls.push(err); });
		expect(calls).toEqual([null]);
	});

	it("settles on load when the library does not announce readiness",function() {
		var url = "http://example.com/library-onload-only";
		openLibrary(url);
		var info = $tw.browserMessaging.iframeInfoMap[url];
		useFakeIFrameWindow(info);
		// Old-style library: no ready message, just the load event
		info.domNode.onload();
		expect(info.status).toBe("loaded");
		expect(messagesReceived.length).toBe(1);
		// A later ready message must not re-deliver callbacks
		dispatchFromIFrame({verb: "ready"});
		expect(messagesReceived.length).toBe(1);
	});

	it("reports an error through the original alert path and records the failure",function() {
		var url = "http://example.com/library-error",
			directErrors = [];
		openLibrary(url);
		var info = $tw.browserMessaging.iframeInfoMap[url];
		info.domNode.onerror();
		expect(info.status).toBe("error");
		expect(window.alert).toHaveBeenCalled();
		// The failure is observable in the connection tiddler, not a silent blank state
		var connectionTiddler = $tw.wiki.getTiddler("$:/temp/ServerConnection/" + url);
		expect(connectionTiddler.fields.text).toBe("error");
		expect(connectionTiddler.fields.error).toBeTruthy();
		// Subsequent callers receive the error rather than hanging forever
		$tw.browserMessaging.loadIFrame(url,function(err) { directErrors.push(err); });
		expect(directErrors.length).toBe(1);
		expect(directErrors[0]).toBeTruthy();
	});

	it("fails pending callbacks with a timeout when readiness never arrives",function() {
		jasmine.clock().install();
		try {
			$tw.browserMessaging.readyTimeout = 1000;
			var url = "http://example.com/library-timeout",
				errors = [];
			$tw.browserMessaging.loadIFrame(url,function(err) { errors.push(err); });
			var info = $tw.browserMessaging.iframeInfoMap[url];
			expect(info.status).toBe("loading");
			jasmine.clock().tick(1001);
			expect(info.status).toBe("error");
			expect(errors.length).toBe(1);
			expect(info.domNode.parentNode).toBeFalsy(); // the dead iframe was removed
		} finally{
			jasmine.clock().uninstall();
		}
	});
});
