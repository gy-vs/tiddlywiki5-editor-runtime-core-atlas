/*\
title: $:/plugins/tiddlywiki/pluginlibrary/libraryserver.js
type: application/javascript
module-type: library

A simple HTTP-over-window.postMessage implementation of a standard TiddlyWeb-compatible server. It uses real HTTP to load the individual tiddler JSON files.

\*/

"use strict";

// Announce to the host window that this library is ready to handle GET messages. This runs as soon as this script executes (and the message listener below is bound), so it also reaches the host when loading of this document is interrupted before the iframe's load event fires.
function announceReady() {
	var target = null;
	try {
		target = (window.parent && window.parent !== window) ? window.parent : window.opener;
	} catch(ex) {
		// Referencing the parent/opener can throw in unusual browsing contexts
		target = null;
	}
	var message = {
		verb: "ready"
	};
	try {
		if(target) {
			target.postMessage(message,"*");
		}
	} catch(ex) {
		// Ignore if the target window is no longer available
	}
	// Re-announce for a short while in case the host has not yet attached its listener (or missed the message while loading)
	var retries = 0;
	var retryTimer = window.setInterval(function() {
		retries++;
		try {
			if(target) {
				target.postMessage(message,"*");
			}
		} catch(ex) {
			// Ignore if the target window is no longer available
		}
		if(retries >= 10) {
			window.clearInterval(retryTimer);
		}
	},100);
}

// Listen for window messages
window.addEventListener("message",function listener(event){
	if(!event.data || typeof event.data !== "object") {
		return;
	}
	console.log("plugin library: Received message from",event.origin);
	console.log("plugin library: Message content",event.data);
	switch(event.data.verb) {
		case "GET":
			if(event.data.url === "recipes/library/tiddlers.json") {
				// Route for recipes/library/tiddlers.json
				event.source.postMessage({
					verb: "GET-RESPONSE",
					status: "200",
					cookies: event.data.cookies,
					url: event.data.url,
					type: "application/json",
					body: JSON.stringify(assetList,null,4)
				},"*");
			} else if(event.data.url.indexOf("recipes/library/tiddlers/") === 0) {
				var url = "recipes/library/tiddlers/" + encodeURIComponent(removePrefix(event.data.url,"recipes/library/tiddlers/"));
				// Route for recipes/library/tiddlers/<uri-encoded-tiddler-title>.json
				httpGet(url,function(err,responseText) {
					if(err) {
						event.source.postMessage({
							verb: "GET-RESPONSE",
							status: "404",
							cookies: event.data.cookies,
							url: event.data.url,
							type: "text/plain",
							body: "Not found"
						},"*");
					} else {
						event.source.postMessage({
							verb: "GET-RESPONSE",
							status: "200",
							cookies: event.data.cookies,
							url: event.data.url,
							type: "application/json",
							body: responseText
						},"*");
					}
				});
			} else {
				event.source.postMessage({
					verb: "GET-RESPONSE",
					status: "404",
					cookies: event.data.cookies,
					url: event.data.url,
					type: "text/plain",
					body: "Not found"
				},"*");
			}
			break;
	}
},false);

// Let the host know the listener above is now bound
announceReady();

// Helper to remove string prefixes
function removePrefix(string,prefix) {
	if(string.indexOf(prefix) === 0) {
		return string.substr(prefix.length);
	} else {
		return string;
	}
}

// Helper for HTTP GET. The callback is always invoked exactly once: with an error on network failure, abort or a non-200 response, so that callers never hang waiting.
function httpGet(url,callback) {
	var completed = false;
	function fail() {
		if(!completed) {
			completed = true;
			callback("Request failed");
		}
	}
	var http = new XMLHttpRequest();
	http.open("GET",url,true);
	http.onreadystatechange = function() {
		if(http.readyState === 4) {
			if(http.status === 200) {
				if(!completed) {
					completed = true;
					callback(null,http.responseText);
				}
			} else {
				fail();
			}
		}
	};
	http.onerror = fail;
	http.onabort = fail;
	http.ontimeout = fail;
	try {
		http.send();
	} catch(ex) {
		fail();
	}
}
