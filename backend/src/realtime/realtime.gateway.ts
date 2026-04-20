import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

/**
 * Realtime gateway — broadcasts alerts, POS events, inventory changes
 * to connected clients. Clients authenticate with a JWT passed in
 * the handshake (auth.token) and subscribe to rooms by role/user.
 */
@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.toString().replace('Bearer ', '');

      if (!token) {
        client.emit('error', { message: 'JWT token required' });
        client.disconnect();
        return;
      }

      const payload = await this.jwt.verifyAsync(token);
      (client as any).user = payload;

      // Join rooms: user:<id> and role:<role>
      if (payload.sub) client.join(`user:${payload.sub}`);
      if (payload.roles && Array.isArray(payload.roles)) {
        for (const r of payload.roles) client.join(`role:${r}`);
      }
      client.join('broadcast');

      this.logger.log(
        `Client ${client.id} connected as user=${payload.sub} roles=${payload.roles?.join(',')}`,
      );

      client.emit('connected', {
        userId: payload.sub,
        rooms: [...client.rooms],
      });
    } catch (err: any) {
      this.logger.warn(`Auth failed: ${err.message}`);
      client.emit('error', { message: 'Invalid token' });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client ${client.id} disconnected`);
  }

  @SubscribeMessage('ping')
  onPing(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    return { pong: Date.now(), echo: data };
  }

  /** Broadcast a new alert to relevant users/roles */
  emitAlert(alert: any) {
    if (alert.target_user_id) {
      this.server.to(`user:${alert.target_user_id}`).emit('alert:new', alert);
    } else {
      this.server.to('broadcast').emit('alert:new', alert);
    }
  }

  /** Broadcast a POS event (invoice created, void, return) */
  emitPosEvent(event: {
    type: 'invoice.created' | 'invoice.voided' | 'return.created';
    payload: any;
  }) {
    this.server.to('role:admin').emit(`pos:${event.type}`, event.payload);
    this.server.to('role:manager').emit(`pos:${event.type}`, event.payload);
  }

  /** Broadcast inventory events */
  emitInventoryEvent(event: {
    type:
      | 'low_stock'
      | 'out_of_stock'
      | 'transfer.shipped'
      | 'transfer.received'
      | 'count.completed';
    payload: any;
  }) {
    this.server
      .to('role:stock_keeper')
      .emit(`inventory:${event.type}`, event.payload);
    this.server
      .to('role:manager')
      .emit(`inventory:${event.type}`, event.payload);
  }

  /** Generic topic broadcast */
  emit(topic: string, payload: any) {
    this.server.to('broadcast').emit(topic, payload);
  }
}
