type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PRIORITIES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CURRENT_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) in LOG_PRIORITIES
    ? (process.env.LOG_LEVEL as LogLevel)
    : "info";
const CURRENT_PRIORITY = LOG_PRIORITIES[CURRENT_LEVEL];
const USE_JSON = process.env.LOG_FORMAT === "json";

function formatLog(level: LogLevel, component: string, message: string, data?: unknown): string {
  if (USE_JSON) {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component,
      msg: message,
    };
    if (data !== undefined) {
      entry.data = data instanceof Error
        ? { error: data.message, stack: data.stack }
        : data;
    }
    return JSON.stringify(entry);
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;
  const dataStr = data !== undefined
    ? ` ${data instanceof Error ? `${data.message}\n${data.stack}` : JSON.stringify(data)}`
    : "";
  return `${prefix} ${message}${dataStr}`;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_PRIORITIES[level] >= CURRENT_PRIORITY;
}

export function createLogger(component: string) {
  const base = {
    info: (message: string, data?: unknown) => {
      if (shouldLog("info")) console.log(formatLog("info", component, message, data));
    },
    warn: (message: string, data?: unknown) => {
      if (shouldLog("warn")) console.warn(formatLog("warn", component, message, data));
    },
    error: (message: string, data?: unknown) => {
      if (shouldLog("error")) console.error(formatLog("error", component, message, data));
    },
    debug: (message: string, data?: unknown) => {
      if (shouldLog("debug")) console.log(formatLog("debug", component, message, data));
    },
    time: (label: string) => {
      const start = performance.now();
      return {
        end: () => {
          const durationMs = Math.round((performance.now() - start) * 100) / 100;
          if (shouldLog("info")) {
            console.log(formatLog("info", component, `${label} completed`, { durationMs }));
          }
        },
      };
    },
  };

  return {
    ...base,
    /**
     * Returns a scoped logger that prefixes every message with [job:N].
     * Per ACP best practice: include jobId in every log entry.
     */
    withJob(jobId: number | string) {
      const prefix = `[job:${jobId}]`;
      return {
        info: (message: string, data?: unknown) => base.info(`${prefix} ${message}`, data),
        warn: (message: string, data?: unknown) => base.warn(`${prefix} ${message}`, data),
        error: (message: string, data?: unknown) => base.error(`${prefix} ${message}`, data),
        debug: (message: string, data?: unknown) => base.debug(`${prefix} ${message}`, data),
        time: (label: string) => base.time(`${prefix} ${label}`),
      };
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
