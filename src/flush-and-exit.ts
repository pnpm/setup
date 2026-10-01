/**
 * Exits the process once stdout and stderr have drained.
 *
 * Both streams are pipes under the Actions runner, where writes are
 * asynchronous, so a bare `process.exit()` discards whatever is still queued:
 * the workflow command `setFailed` wrote and the error `console.error` printed
 * reach the runner only after the drain.
 */
export function flushAndExit() {
  let pending = 2
  const exitWhenDrained = () => {
    pending -= 1
    if (pending === 0) process.exit()
  }
  process.stdout.write('', exitWhenDrained)
  process.stderr.write('', exitWhenDrained)
}
