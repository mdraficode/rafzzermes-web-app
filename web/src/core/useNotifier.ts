import { useSyncExternalStore } from 'react';
import type { ChangeNotifier } from './notifier';

/**
 * Subscribes a component to a ChangeNotifier.
 *
 * Replaces Flutter's `context.watch<T>()` / `Consumer<T>`: the notifier's
 * `version` counter is the snapshot, so the component re-renders exactly when
 * `notify()` fires.
 */
export function useNotifier<T extends ChangeNotifier>(notifier: T): T {
  useSyncExternalStore(
    notifier.subscribe,
    () => notifier.version,
    () => notifier.version,
  );
  return notifier;
}
