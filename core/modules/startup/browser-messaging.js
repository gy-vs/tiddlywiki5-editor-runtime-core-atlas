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
Load a specified url as an iframe and call the callback when it is loaded. If the url is already loaded then the existing iframe instance is used. Callbacks made while the iframe is still loading are queued, and are invoked once the iframe is ready or has failed
*/
function loadIFrame(url,callback) {
	// Check if iframe already exists
	var iframeInfo = $tw.browserMessaging.iframeInfoMap[url];
	if(iframeInfo) {
		if(iframeInfo.status === "loading") {
			// The iframe is still loading, so queue the callback to be invoked once it is ready
			iframeInfo.callbacks.push(callback);
			return;
		} else if(iframeInfo.status === "loaded") {
			// We've already got the iframe
			callback(null,iframeInfo);
			return;
		}
		// The previous load failed, so remove the defunct iframe and retry with a new one
		unloadIFrame(url);
	}
	createIFrame(url,callback);
}

/*
Create a new library iframe for a given url
*/
function createIFrame(url,callback) {
	// Create the iframe and save it in the list
	var iframe = document.createElement("iframe");
	var iframeInfo = {
		url: url,
		status: "loading",
		domNode: iframe,
		callbacks: [callback]
	};
	$tw.browserMessaging.iframeInfoMap[url] = iframeInfo;
	saveIFrameInfoTiddler(iframeInfo);
	// Add the iframe to the DOM and hide it
	iframe.style.display = "none";
	iframe.setAttribute("library","true");
	document.body.appendChild(iframe);
	// Set up onload and onerror
	iframe.onload = function() {
		iframeHasLoaded(iframeInfo);
	};
	iframe.onerror = function() {
		iframeHasFailed(iframeInfo,"Cannot load iframe");
	};
	try {
		iframe.src = url;
	} catch(ex) {
		iframeHasFailed(iframeInfo,ex);
	}
}

/*
Mark a library iframe as ready and invoke any queued callbacks. Triggered by the iframe onload event, or by a READY message from the library itself (the onload event is not guaranteed to fire if loading is interrupted after the library script has run)
*/
function iframeHasLoaded(iframeInfo) {
	if(iframeInfo.status !== "loaded") {
		iframeInfo.status = "loaded";
		saveIFrameInfoTiddler(iframeInfo);
		flushIFrameCallbacks(iframeInfo,null);
	}
}

/*
Mark a library iframe as failed and invoke any queued callbacks with the error
*/
function iframeHasFailed(iframeInfo,err) {
	if(iframeInfo.status === "loading") {
		iframeInfo.status = "error";
		saveIFrameInfoTiddler(iframeInfo);
		flushIFrameCallbacks(iframeInfo,err);
	}
}

/*
Invoke and clear the callbacks that were queued while a library iframe was loading
*/
function flushIFrameCallbacks(iframeInfo,err) {
	var callbacks = iframeInfo.callbacks;
	iframeInfo.callbacks = [];
	$tw.utils.each(callbacks,function(callback) {
		callback(err,iframeInfo);
	});
}

/*
Find the info of the library iframe with a given content window
*/
function findIFrameInfoByContentWindow(contentWindow) {
	var result = null;
	$tw.utils.each($tw.browserMessaging.iframeInfoMap,function(iframeInfo) {
		if(iframeInfo && iframeInfo.domNode.contentWindow === contentWindow) {
			result = iframeInfo;
		}
	});
	return result;
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
		url: iframeInfo.url
	},$tw.wiki.getModificationFields()));
}

exports.startup = function() {
	// Initialise the store of iframes we've created
	$tw.browserMessaging = {
		iframeInfoMap: {} // Hashmap by URL of {url:,status:"loading" | "loaded" | "error",domNode:,callbacks:}
	};
	// Listen for widget messages to control loading the plugin library
	$tw.rootWidget.addEventListener("tm-load-plugin-library",function(event) {
		var paramObject = event.paramObject || {},
			url = paramObject.url;
		if(url) {
			loadIFrame(url,function(err,iframeInfo) {
				if(err) {
					alert($tw.language.getString("Error/LoadingPluginLibrary") + ": " + url);
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
		$tw.browserMessaging.iframeInfoMap[url] = undefined;
		if(url) {
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
					alert($tw.language.getString("Error/LoadingPluginLibrary") + ": " + url);
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
		switch(event.data.verb) {
			case "READY":
				// A library iframe is announcing that its script has run and is listening for messages. This is used as a fallback for the iframe onload event, which is not guaranteed to fire if loading is interrupted
				var iframeInfo = findIFrameInfoByContentWindow(event.source);
				if(iframeInfo) {
					iframeHasLoaded(iframeInfo);
				}
				break;
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
