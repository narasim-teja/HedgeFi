type LogLevel = "info" | "warn" | "error" | "debug";

function formatLog(level: LogLevel, component: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;
  const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  return `${prefix} ${message}${dataStr}`;
}

export function createLogger(component: string) {
  return {
    info: (message: string, data?: unknown) =>
      console.log(formatLog("info", component, message, data)),
    warn: (message: string, data?: unknown) =>
      console.warn(formatLog("warn", component, message, data)),
    error: (message: string, data?: unknown) =>
      console.error(formatLog("error", component, message, data)),
    debug: (message: string, data?: unknown) =>
      console.log(formatLog("debug", component, message, data)),
  };
}

export type Logger = ReturnType<typeof createLogger>;
