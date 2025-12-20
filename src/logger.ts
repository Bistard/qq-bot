export class Logger {
  constructor(private scope: string) {}

  private format(level: string, args: any[]) {
    const ts = new Date().toISOString()
    return [`[${ts}] [${level}] [${this.scope}]`, ...args]
  }

  info(...args: any[]) {
    console.log(...this.format('INFO', args))
  }

  warn(...args: any[]) {
    console.warn(...this.format('WARN', args))
  }

  error(...args: any[]) {
    console.error(...this.format('ERROR', args))
  }
}
