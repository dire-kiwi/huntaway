// Port of server/src/hosts/broker.rs, thin: dialling out to a broker (`serve --broker <url>`) isn't in the TypeScript
// server (main.ts says so at startup). What's kept: the header that marks requests made for a broker's clients, and
// resolving a host URL, which for anything but a broker's `/_broker/h/<name>` URL is the URL itself. (Rust's
// hosts/broker/tests.rs is about the broker connection, so it isn't ported.)

/**
 * Marks the requests we make on our own server for the broker's clients, so a route that mustn't be reached through
 * the broker can refuse them however their path is spelled.
 */
export const VIA_BROKER = "x-huntaway-via-broker";

/**
 * Resolve an explicit broker host URL before sending a host/hub token or opening a websocket. Brokers aren't supported
 * here, so a `/_broker/h/<name>` URL is an error, and any other is used as it is (Rust also asks a URL without a path
 * whether it's a broker's).
 */
export async function resolve(url: string, _expected_host: string | null): Promise<string> {
  let base: URL;
  try {
    base = new URL(url);
  } catch (e) {
    throw new Error("bad host URL", { cause: e });
  }
  if (base.pathname.replace(/\/+$/, "").startsWith("/_broker/")) throw new Error("brokers aren't supported by the TypeScript server");
  return url;
}
