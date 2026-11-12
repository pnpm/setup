import { spawn } from 'node:child_process'

/** The version the pnpm executable at `pnpmBin` reports. */
export function readVersion (pnpmBin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Check the downloaded binary itself, not a version selected by the project.
    const cp = spawn(pnpmBin, ['--config.pm-on-fail=ignore', '--version'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    cp.stdout.on('data', (chunk) => {
      output += chunk
    })
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim())
      } else {
        reject(new Error(`"${pnpmBin} --version" exited with code ${code}`))
      }
    })
  })
}
