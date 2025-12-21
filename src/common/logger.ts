export class Logger {
	constructor(private scope: string) {}

	private format(level: string, args: unknown[]) {
		const ts = new Date().toISOString();
		return [`[${ts}] [${level}] [${this.scope}]`, ...args];
	}

	info(...args: unknown[]) {
		console.log(...this.format('INFO', args));
	}

	warn(...args: unknown[]) {
		console.warn(...this.format('WARN', args));
	}

	error(...args: unknown[]) {
		console.error(...this.format('ERROR', args));
	}
}
