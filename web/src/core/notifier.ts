/**
 * ChangeNotifier — the browser analogue of Flutter's `ChangeNotifier`
 * (package:flutter/foundation, used indirectly via `provider` in the Android app).
 *
 * `RelayProvider`, `ChatController` and `ThemeController` all extend this, so the
 * state-management shape of the web app mirrors the Android app's.
 *
 * `subscribe` is an arrow-function property (stable identity) and `version`
 * changes on every notification, which is exactly what `useSyncExternalStore`
 * needs to tear-render safely under React 19 concurrent rendering.
 */
export type Listener = () => void;

export class ChangeNotifier {
  private listeners = new Set<Listener>();

  /** Bumped on every `notify()`. Read by `useNotifier` as its snapshot. */
  version = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected notify(): void {
    this.version += 1;
    // Copy first: a listener may unsubscribe (or subscribe) during dispatch.
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** No-op in JS (no GC finalizers); kept so `dispose()` overrides stay honest. */
  dispose(): void {
    this.listeners.clear();
  }
}
