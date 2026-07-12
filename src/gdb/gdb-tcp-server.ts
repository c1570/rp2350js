import { createServer, Socket } from 'net';
import { GDBConnection } from './gdb-connection';
import { GDBServer } from './gdb-server';

/**
 * TCP wrapper for any GDBServer subclass. Listens on a port and creates
 * a GDBConnection for each incoming socket.
 */
export class GDBTCPServer {
  private socketServer = createServer();

  constructor(readonly server: GDBServer, readonly port: number = 3333) {
    this.socketServer.listen(port);
    this.socketServer.on('connection', (socket) => this.handleConnection(socket));
  }

  handleConnection(socket: Socket) {
    this.server.info('GDB connected');
    socket.setNoDelay(true);

    const connection = new GDBConnection(this.server, (data) => {
      socket.write(data);
    });

    socket.on('data', (data) => {
      connection.feedData(data.toString('utf-8'));
    });

    socket.on('error', (err) => {
      this.server.removeConnection(connection);
      this.server.error(`GDB socket error ${err}`);
    });

    socket.on('close', () => {
      this.server.removeConnection(connection);
      this.server.info('GDB disconnected');
    });
  }
}
