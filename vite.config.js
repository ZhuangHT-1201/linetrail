import { createLogger, defineConfig } from "vite";

// The engine and UI intentionally remain classic scripts so the finished
// project also works when index.html is opened directly from disk.
const logger = createLogger();
const emitWarning = logger.warn.bind(logger);
logger.warn = (message, options) => {
  if (
    typeof message === "string" &&
    message.includes('can\'t be bundled without type="module"')
  ) {
    return;
  }
  emitWarning(message, options);
};

export default defineConfig({
  customLogger: logger
});
