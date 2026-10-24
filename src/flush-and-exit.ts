/**
 * stdout and stderr are pipes under the Actions runner, where writes are
 * asynchronous, so a bare `process.exit()` discards whatever is still queued:
 * the workflow command `setFailed` wrote and the error `console.error` printed
 * reach the runner only after the drain.
 */
export function flushAndExit (): void {
  let pending = 2
  const exitWhenDrained = () => {
    pending -= 1
    // eslint-disable-next-line n/no-process-exit -- ending the process is the point: open requests would otherwise keep it alive
    if (pending === 0) process.exit()
  }
  process.stdout.write('', exitWhenDrained)
  process.stderr.write('', exitWhenDrained)
}
