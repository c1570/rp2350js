import { ConsoleLogger, Logger, LogLevel } from '../utils/logging';
import { GDBConnection } from './gdb-connection';

const LOG_NAME = 'GDBServer';

export const STOP_REPLY_SIGINT = 'S02';

/**
 * Base class for GDB protocol servers. Handles connection lifecycle,
 * logging, and breakpoint notification. Subclasses implement
 * processGDBMessage() with architecture-specific register/memory handling.
 */
export abstract class GDBServer {
  public logger: Logger = new ConsoleLogger(LogLevel.Warn, true);

  private readonly connections = new Set<GDBConnection>();

  abstract processGDBMessage(cmd: string): string | void;

  addConnection(connection: GDBConnection) {
    this.connections.add(connection);
  }

  removeConnection(connection: GDBConnection) {
    this.connections.delete(connection);
  }

  /** Called when a breakpoint/halt is hit during execution. */
  notifyBreakpoint(threadId: number = 1) {
    for (const connection of this.connections) {
      connection.onBreakpoint(threadId);
    }
  }

  /** Called when GDB sends Ctrl-C (interrupt). Subclasses stop execution. */
  onInterrupt?: () => void;

  debug(msg: string) {
    this.logger.debug(LOG_NAME, msg);
  }

  info(msg: string) {
    this.logger.info(LOG_NAME, msg);
  }

  warn(msg: string) {
    this.logger.warn(LOG_NAME, msg);
  }

  error(msg: string) {
    this.logger.error(LOG_NAME, msg);
  }
}
