import { type Ref, useImperativeHandle, useMemo, useRef } from "react"
import { WebView } from "react-native-webview"
import { deliverScript, type FrameReply } from "../logic/frame"
import { parseJson } from "../logic/json"
import { colors } from "../theme"

// A frame for a page of a plugin's (logic/frame.ts' `frameDocument`), on a phone: a web view that loads the page's text
// and nothing else. The page has no origin (its address is about:blank), no storage, no cookies, no files, no other
// window, and the policy in it holds the network; whatever it tries to go to is refused here, links included, which
// reach the app as messages instead. frameView.web.tsx is the same thing for the app's web build.

/** What the app says back into a frame's page. */
export interface FrameHandle {
  readonly deliver: (reply: FrameReply) => void
}

export interface FrameViewProps {
  readonly html: string
  readonly title: string
  /** Its height when the page says it (a task's section); null to fill what it is in. */
  readonly height: number | null
  /** What the page posted, as a value. */
  readonly onMessage: (data: unknown) => void
  readonly ref?: Ref<FrameHandle>
}

/** A page's own documents: its first load, and a frame of the page's with its text in it. Nothing with an address. */
const ownDocument = (url: string): boolean => /^about:(blank|srcdoc)/i.test(url)

export function FrameView({ html, title, height, onMessage, ref }: FrameViewProps) {
  // (The library types its props as `WebViewProps & P`, and `P` as undefined unless it is said.)
  const web = useRef<WebView<object>>(null)
  useImperativeHandle(ref, () => ({ deliver: (reply) => web.current?.injectJavaScript(deliverScript(reply)) }), [])
  // The same page is the same source: the view loads again only when its text changes.
  const source = useMemo(() => ({ html, baseUrl: "about:blank" }), [html])
  return (
    <WebView<object>
      ref={web}
      accessibilityLabel={title}
      source={source}
      // Every address is the app's to decide on (below): one the library's own list left out would go to the browser.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => ownDocument(request.url)}
      onMessage={(event) => onMessage(parseJson(event.nativeEvent.data))}
      // A new window would be opened in the browser; with none, it is a load of this view, refused above.
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      incognito
      cacheEnabled={false}
      thirdPartyCookiesEnabled={false}
      sharedCookiesEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      geolocationEnabled={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      allowsBackForwardNavigationGestures={false}
      mediaPlaybackRequiresUserAction
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      scrollEnabled={height === null}
      nestedScrollEnabled
      style={height === null ? { flex: 1, backgroundColor: colors.bg } : { height, flexGrow: 0, backgroundColor: "transparent" }}
      containerStyle={height === null ? { flex: 1 } : { height, flexGrow: 0 }}
    />
  )
}
