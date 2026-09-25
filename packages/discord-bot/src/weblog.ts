/**
 * In-memory log ring buffer (Fase web): the backend logs here, the
 * frontend drains via GET /api/logs?after=. stdout keeps everything.
 */

export interface LogRecord {
	id: number;
	time: string;
	level: "debug" | "info" | "warn" | "error";
	msg: string;
	attrs?: Record<string, unknown>;
}

const CAPACITY = 2000;

export class LogBuffer {
	private seq = 0;
	private readonly records: LogRecord[] = [];

	log(level: LogRecord["level"], msg: string, attrs?: Record<string, unknown>): void {
		this.seq += 1;
		this.records.push({ id: this.seq, time: new Date().toISOString(), level, msg, attrs });
		if (this.records.length > CAPACITY) this.records.splice(0, this.records.length - CAPACITY);
		const line = attrs ? `${msg} ${JSON.stringify(attrs)}` : msg;
		if (level === "error") console.error(line);
		else console.log(line);
	}

	after(cursor: number, limit = 300): { entries: LogRecord[]; cursor: number } {
		const entries = this.records.filter((r) => r.id > cursor).slice(-limit);
		return { entries, cursor: this.seq };
	}
}
