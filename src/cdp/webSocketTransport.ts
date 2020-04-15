/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITransport } from './transport';
import WebSocket from 'ws';
import { isLoopback } from '../common/urlUtils';
import { timeoutPromise } from '../common/cancellation';
import { EventEmitter } from '../common/events';
import type { CancellationToken } from 'vscode';

export class WebSocketTransport implements ITransport {
  private _ws: WebSocket | undefined;
  private readonly messageEmitter = new EventEmitter<[string, bigint]>();
  private readonly endEmitter = new EventEmitter<void>();

  public readonly onMessage = this.messageEmitter.event;
  public readonly onEnd = this.endEmitter.event;

  /**
   * Creates a WebSocket transport by connecting to the given URL.
   */
  static async create(
    url: string,
    cancellationToken: CancellationToken,
  ): Promise<WebSocketTransport> {
    const isSecure = !url.startsWith('ws://');
    const targetAddressIsLoopback = await isLoopback(url);

    const ws = new WebSocket(url, [], {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024, // 256Mb
      rejectUnauthorized: !(isSecure && targetAddressIsLoopback),
      followRedirects: true,
    });

    return timeoutPromise(
      new Promise<WebSocketTransport>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(new WebSocketTransport(ws)));
        ws.addEventListener('error', reject);
      }),
      cancellationToken,
      `Could not open ${url}`,
    ).catch(err => {
      ws.close();
      throw err;
    });
  }

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.addEventListener('message', event => {
      this.messageEmitter.fire([event.data, process.hrtime.bigint()]);
    });
    this._ws.addEventListener('close', () => {
      this.endEmitter.fire();
      this._ws = undefined;
    });
    this._ws.addEventListener('error', () => {
      // Silently ignore all errors - we don't know what to do with them.
    });
  }

  /**
   * @inheritdoc
   */
  send(message: string) {
    this._ws?.send(message);
  }

  /**
   * @inheritdoc
   */
  dispose() {
    return new Promise<void>(resolve => {
      if (!this._ws) {
        return resolve();
      }

      this._ws.addEventListener('close', resolve);
      this._ws.close();
    });
  }
}
