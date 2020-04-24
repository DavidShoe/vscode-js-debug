/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import CdpConnection from '../../cdp/connection';
import { IEdgeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { IWebViewConnectionInfo } from '../targets';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { IDeferred } from '../../common/promiseUtil'
import { getDeferred } from '../../common/promiseUtil';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { NeverCancelled } from '../../common/cancellation';
import { join } from 'path';
import Dap from '../../dap/api';
import { CancellationToken } from 'vscode';
import { createTargetFilter } from '../../common/urlUtils';
import { BrowserLauncher } from './browserLauncher';
import { DebugType } from '../../common/contributionUtils';
import { StoragePath, FS, FsPromises, BrowserFinder, IInitializeParams } from '../../ioc-extras';
import { inject, tagged, injectable } from 'inversify';
import { ILogger } from '../../common/logging';
import { once } from '../../common/objUtils';
import { canAccess } from '../../common/fsUtils';
import { browserNotFound, ProtocolError } from '../../dap/errors';
import { IBrowserFinder, isQuality } from 'vscode-js-debug-browsers';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { Cdp} from '../../cdp/api';


class ConnectionInfo {
  public port: number = 0;
  public id: string = "";
  public connection!: CdpConnection;
}

@injectable()
export class EdgeLauncher extends BrowserLauncher<IEdgeLaunchConfiguration> {

  private _connections: Array<ConnectionInfo> = [];

  private filter!: (url: string) => boolean;

  private launchConfig!: IEdgeLaunchConfiguration;

  private info!: IWebViewConnectionInfo;

  private webViewStartDebugPromise!: IDeferred<number>;

  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(BrowserFinder)
    @tagged('browser', 'edge')
    protected readonly browserFinder: IBrowserFinder,
    @inject(FS)
    private readonly fs: FsPromises,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
  ) {
    super(storagePath, logger, pathResolver, initializeParams);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Edge &&
      params.request === 'launch' &&
      params.browserLaunchLocation === 'workspace'
      ? params
      : undefined;
  }

  /**
   * @override
   */
  protected launchBrowser(
    params: IEdgeLaunchConfiguration,
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    telemetryReporter: ITelemetryReporter,
  ) {

    this.filter = createTargetFilter(params.urlFilter);
    this.launchConfig = params;

    return super.launchBrowser(
      params,
      dap,
      cancellationToken,
      telemetryReporter,
      params.useWebView
        ? this.getWebviewPort(params, telemetryReporter)
        : undefined,
    );
  }

  /**
   * Gets the port number we should connect to for debugging webviews in the target.
   */
  private async getWebviewPort(
    params: IEdgeLaunchConfiguration,
//    filter: (info: IWebViewConnectionInfo) => boolean,
    telemetryReporter: ITelemetryReporter,
  ): Promise<number> {
    const promisedPort: IDeferred<number> = getDeferred<number>();

    // Cache this for later resolving when we get a matching webview target
    this.webViewStartDebugPromise = promisedPort;

    if (!params.runtimeExecutable) {
      // runtimeExecutable is required for web view debugging.
      promisedPort.resolve(params.port);
      return promisedPort.promise;
    }

    const exeName = params.runtimeExecutable.split(/\\|\//).pop();
    const pipeName = `VSCode_${randomBytes(12).toString('base64')}`;
    // This is a known pipe name scheme described in the web view documentation
    // https://docs.microsoft.com/microsoft-edge/hosting/webview2/reference/webview2.idl
    const serverName = `\\\\.\\pipe\\WebView2\\Debugger\\${exeName}\\${pipeName}`;

    const server = createServer(stream => {
      stream.on('data', async data => {
        this.info = JSON.parse(data.toString());

        console.log("New webview connection: " + this.info.url);

        // devtoolsActivePort will always start with the port number
        // and look something like '92202\n ...'
        const dtString = this.info.devtoolsActivePort || '';
        const dtPort = parseInt(dtString.split('\n').shift() || '');
        const port = params.port || dtPort || params.port;

        // All web views started under our debugger are waiting to to be resumed.
        const wsURL = `ws://${params.address}:${port}/devtools/${this.info.type}/${this.info.id}`;
        const ws = await WebSocketTransport.create(wsURL, NeverCancelled);
        const connection = new CdpConnection(ws, this.logger, telemetryReporter);

        // keep the list of connections so we can lookup the port to debug on and clean up later
        const newConnection: ConnectionInfo = new ConnectionInfo();
        newConnection.id = this.info.id;
        newConnection.port = port;
        newConnection.connection = connection;
        this._connections.push(newConnection);

        // Get navigation events so we can watch for the target URL
        connection.rootSession().Page.on('frameNavigated', event => this._onFrameNavigated(event));
        connection.rootSession().Page.enable({}); // if you don't enable you won't get the frameNavigated events

        await connection.rootSession().Runtime.runIfWaitingForDebugger({});
        // Note: do not close the connection, we need it open to get the navigation events
        //connection.close();
      });
    });
    server.on('error', promisedPort.reject);
    server.on('close', () => promisedPort.resolve(params.port));
    server.listen(serverName);

    // We must set a user data directory so the DevToolsActivePort file will be written.
    // See: https://crrev.com//21e1940/content/public/browser/devtools_agent_host.h#99
    params.userDataDir =
      params.userDataDir || join(tmpdir(), `vscode-js-debug-userdatadir_${params.port}`);

    // Web views are indirectly configured for debugging with environment variables.
    // See the WebView2 documentation for more details.
    params.env = params.env || {};
    params.env['WEBVIEW2_USER_DATA_FOLDER'] = params.userDataDir.toString();
    params.env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = `--remote-debugging-port=${params.port}`;
    params.env['WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER'] = 'true';
    params.env['WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER'] = pipeName;

    return promisedPort.promise;
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(executablePath: string): Promise<string> {
    let resolvedPath: string | undefined;

    const discover = once(() => this.browserFinder.findAll());
    if (isQuality(executablePath)) {
      resolvedPath = (await discover()).find(r => r.quality === executablePath)?.path;
    } else {
      resolvedPath = executablePath;
    }

    if (!resolvedPath || !(await canAccess(this.fs, resolvedPath))) {
      throw new ProtocolError(
        browserNotFound(
          'Edge',
          executablePath,
          (await discover()).map(b => b.quality),
        ),
      );
    }

    return resolvedPath;
  }


  private async _onFrameNavigated(framePayload: Cdp.Page.FrameNavigatedEvent) {
    const url = framePayload.frame.url;
    const id = framePayload.frame.id;
    console.log('onFrameNavigated: ' + url + " ID: " + id);

    //const webViewTarget = [{ url: url } as chromeConnection.ITarget];
    console.log('checking for matching target: ' + url + ' <=> ' + this.launchConfig.urlFilter);

    // // If we are not already debugging a target and this webview matches the filter for the destination URL
    if (!this._mainTarget && this.filter(url)) {
      console.log('found web target matching filter');


      // Lookup the port number of the matching connection and close the navigation events as we are done with them
      for (const key in this._connections) {
          if (this._connections[key].id === id) {
              // Found it
              console.log('Found connection to activate');
              this.webViewStartDebugPromise.resolve(this._connections[key].port); // start the debugging over this port.
          }

          //this._connections[key].connection.close();
      }

      // clean up the connection cache array.
      //this._connections.length = 0;

      // And we can close the main pipe as we can't reconnect
      await this.closePipeServer();

    } else {
        console.log('Non matching web target');
    }
  }

  private async closePipeServer() {
      // await new Promise((resolve) => {
      //     if (this._webviewPipeServer) {
      //         this._webviewPipeServer.close(() => {
      //             resolve();
      //         });
      //     } else {
      //         resolve();
      //     }
      // });
  }
}
