/*\
title: $:/core/modules/browser-messaging.js
type: application/javascript
module-type: startup

Browser message handling

\*/

"use strict";

// Export name and synchronous status
exports.name = "browser-messaging";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

/*
Time in milliseconds to wait for the plugin library script inside the iframe to announce that it is ready before giving up
*/
var LIBRARY_READY_TIMEOUT = 30 * 1000;

/*
Load a specified url as an iframe and call the callback when it is ready. Calls made while the iframe is still loading are queued and all invoked once the iframe is ready. If the url is already loaded then the existing iframe instance is used.
*/
function loadIFrame(url,callback) {
	var browserMessaging = $tw.browserMessaging;
	// Check if iframe already exists
	var iframeInfo = browserMessaging.iframeInfoMap[url];
	if(iframeInfo) {
		if(iframeInfo.status === "loaded") {
			// We've already got the ready iframe
			callback(null,iframeInfo);
		} else if(iframeInfo.status === "error") {
			// The previous load failed: report it
			callback(iframeInfo.error || "Cannot load iframe",iframeInfo);
		} else {
			// Still loading: queue the callback so that it is not lost while the iframe is unavailable
			iframeInfo.pendingCallbacks.push(callback);
		}
	} else {
		// Create the iframe and save it in the list
		var iframe = document.createElement("iframe");
		iframeInfo = {
			url: url,
			status: "loading",
			domNode: iframe,
			pendingCallbacks: [callback]
		};
		browserMessaging.iframeInfoMap[url] = iframeInfo;
		saveIFrameInfoTiddler(iframeInfo);
		// Add the iframe to the DOM and hide it
		iframe.style.display = "none";
		iframe.setAttribute("library","true");
		document.body.appendChild(iframe);
		// Give up if the library script never becomes ready (e.g. the iframe load was interrupted before it could run)
		iframeInfo.readyTimer = window.setTimeout(function() {
			finishIFrameWithError(iframeInfo,"Timed out waiting for the plugin library to become ready");
		},browserMessaging.readyTimeout);
		// Set up onload. Note that onload is not sufficient by itself: when loading of the iframe document is interrupted after its inline scripts have already run, onload may never fire even though the library message listener is bound. Such a library announces itself with a "ready" message, which settles the iframe as soon as the listener is registered.
		iframe.onload = function() {
			// Settle the iframe once, whichever signal arrives first: onload (libraries that don't announce) or the ready message
			settleIFrame(iframeInfo);
		};
		iframe.onerror = function() {
			finishIFrameWithError(iframeInfo,"Cannot load iframe");
		};
		try {
			iframe.src = url;
		} catch(ex) {
			finishIFrameWithError(iframeInfo,ex);
		}
	}
}

/*
Mark the iframe as loaded and invoke any queued callbacks. Safe to call from either the onload event or the ready message; only the first call has an effect.
*/
function settleIFrame(iframeInfo) {
	if(iframeInfo.status !== "loading") {
		return;
	}
	clearReadyTimer(iframeInfo);
	iframeInfo.status = "loaded";
	saveIFrameInfoTiddler(iframeInfo);
	var callbacks = iframeInfo.pendingCallbacks;
	iframeInfo.pendingCallbacks = [];
	$tw.utils.each(callbacks,function(cb) {
		cb(null,iframeInfo);
	});
}

/*
Mark the iframe as failed, invoke queued callbacks with the error and make its state observable so that loading can be retried
*/
function finishIFrameWithError(iframeInfo,error) {
	if(iframeInfo.status !== "loading") {
		return;
	}
	clearReadyTimer(iframeInfo);
	iframeInfo.status = "error";
	iframeInfo.error = (error && error.message) ? error.message : error;
	saveIFrameInfoTiddler(iframeInfo);
	// Remove the failed iframe from the DOM (its state is retained in the connection tiddler)
	var domNode = iframeInfo.domNode;
	if(domNode && domNode.parentNode) {
		domNode.parentNode.removeChild(domNode);
	}
	var callbacks = iframeInfo.pendingCallbacks;
	iframeInfo.pendingCallbacks = [];
	$tw.utils.each(callbacks,function(cb) {
		cb(iframeInfo.error,iframeInfo);
	});
}

function clearReadyTimer(iframeInfo) {
	if(iframeInfo.readyTimer !== null && iframeInfo.readyTimer !== undefined) {
		window.clearTimeout(iframeInfo.readyTimer);
		iframeInfo.readyTimer = null;
	}
}

/*
Remove an iframe entry for a url, discarding any callbacks still waiting for it
*/
function removeIFrame(url) {
	var iframeInfo = $tw.browserMessaging.iframeInfoMap[url];
	if(iframeInfo) {
		clearReadyTimer(iframeInfo);
		$tw.browserMessaging.iframeInfoMap[url] = undefined;
		var domNode = iframeInfo.domNode;
		if(domNode && domNode.parentNode) {
			domNode.parentNode.removeChild(domNode);
		}
		// Drop callbacks that were queued while the iframe was loading
		iframeInfo.pendingCallbacks = [];
	}
}

/*
Unload library iframe for given url
*/
function unloadIFrame(url){
	var iframes = document.getElementsByTagName("iframe");
	for(var t = iframes.length - 1; t >= 0; t--) {
		var iframe = iframes[t];
		if(iframe.getAttribute("library") === "true" &&
		  iframe.getAttribute("src") === url) {
			iframe.parentNode.removeChild(iframe);
		}
	}
}

function saveIFrameInfoTiddler(iframeInfo) {
	$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),{
		title: "$:/temp/ServerConnection/" + iframeInfo.url,
		text: iframeInfo.status,
		tags: ["$:/tags/ServerConnection"],
		url: iframeInfo.url,
		"error": (iframeInfo.status === "error" ? iframeInfo.error : undefined)
	},$tw.wiki.getModificationFields()));
}

exports.startup = function() {
	// Initialise the store of iframes we've created
	$tw.browserMessaging = {
		iframeInfoMap: {}, // Hashmap by URL of {url:,status:"loading/loaded/error",domNode:,pendingCallbacks:[]}
		readyTimeout: LIBRARY_READY_TIMEOUT,
		// Exposed for reuse/testing
		loadIFrame: loadIFrame,
		settleIFrame: settleIFrame,
		finishIFrameWithError: finishIFrameWithError
	};
	// Display the error raised while loading a plugin library
	function alertLibraryError(url,error) {
		alert($tw.language.getString("Error/LoadingPluginLibrary") + ": " + url + (error ? " (" + error + ")" : ""));
	}
	// Listen for widget messages to control loading the plugin library
	$tw.rootWidget.addEventListener("tm-load-plugin-library",function(event) {
		var paramObject = event.paramObject || {},
			url = paramObject.url;
		if(url) {
			loadIFrame(url,function(err,iframeInfo) {
				if(err) {
					alertLibraryError(url,err);
				} else {
					iframeInfo.domNode.contentWindow.postMessage({
						verb: "GET",
						url: "recipes/library/tiddlers.json",
						cookies: {
							type: "save-info",
							infoTitlePrefix: paramObject.infoTitlePrefix || "$:/temp/RemoteAssetInfo/",
							url: url
						}
					},"*");
				}
			});
		}
	});
	// Listen for widget messages to control unloading the plugin library
	$tw.rootWidget.addEventListener("tm-unload-plugin-library",function(event) {
		var paramObject = event.paramObject || {},
			url = paramObject.url;
		if(url) {
			removeIFrame(url);
			unloadIFrame(url);
			$tw.utils.each(
				$tw.wiki.filterTiddlers("[[$:/temp/ServerConnection/" + url + "]] [prefix[$:/temp/RemoteAssetInfo/" + url + "/]]"),
				function(title) {
					$tw.wiki.deleteTiddler(title);
				}
			);
		}
	});
	$tw.rootWidget.addEventListener("tm-load-plugin-from-library",function(event) {
		var paramObject = event.paramObject || {},
			url = paramObject.url,
			title = paramObject.title;
		if(url && title) {
			loadIFrame(url,function(err,iframeInfo) {
				if(err) {
					alertLibraryError(url,err);
				} else {
					iframeInfo.domNode.contentWindow.postMessage({
						verb: "GET",
						url: "recipes/library/tiddlers/" + encodeURIComponent(title) + ".json",
						cookies: {
							type: "save-tiddler",
							url: url
						}
					},"*");
				}
			});
		}
	});
	// Listen for window messages from other windows
	window.addEventListener("message",function listener(event){
		// console.log("browser-messaging: ",document.location.toString())
		// console.log("browser-messaging: Received message from",event.origin);
		// console.log("browser-messaging: Message content",event.data);
		if(!event.data || typeof event.data !== "object") {
			return;
		}
		// A plugin library iframe announces itself as soon as its message listener is bound. This is the primary readiness signal: it also fires when the iframe document finishes loading its scripts but the load itself is interrupted (so onload never fires).
		if(event.data.verb === "ready" && event.source) {
			$tw.utils.each($tw.browserMessaging.iframeInfoMap,function(iframeInfo) {
				if(iframeInfo && iframeInfo.status === "loading" && iframeInfo.domNode.contentWindow === event.source) {
					settleIFrame(iframeInfo);
				}
			});
			return;
		}
		switch(event.data.verb) {
			case "GET-RESPONSE":
				if(event.data.status.charAt(0) === "2") {
					if(event.data.cookies) {
						if(event.data.cookies.type === "save-info") {
							var tiddlers = $tw.utils.parseJSONSafe(event.data.body);
							$tw.utils.each(tiddlers,function(tiddler) {
								$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),tiddler,{
									title: event.data.cookies.infoTitlePrefix + event.data.cookies.url + "/" + tiddler.title,
									"original-title": tiddler.title,
									text: "",
									type: "text/vnd.tiddlywiki",
									"original-type": tiddler.type,
									"plugin-type": undefined,
									"original-plugin-type": tiddler["plugin-type"],
									"module-type": undefined,
									"original-module-type": tiddler["module-type"],
									tags: ["$:/tags/RemoteAssetInfo"],
									"original-tags": $tw.utils.stringifyList(tiddler.tags || []),
									"server-url": event.data.cookies.url
								},$tw.wiki.getModificationFields()));
							});
						} else if(event.data.cookies.type === "save-tiddler") {
							var tiddler = $tw.utils.parseJSONSafe(event.data.body);
							$tw.wiki.addTiddler(new $tw.Tiddler(tiddler));
						}
					}
				}
				break;
		}
	},false);
};
