/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import { AnyLaunchConfiguration } from '../configuration';
import { ILogger } from '../common/logging';
import { DebugType } from '../common/contributionUtils';
import { NodeSourcePathResolver } from './node/nodeSourcePathResolver';
import { baseURL } from './browser/browserLaunchParams';
import { BrowserSourcePathResolver } from './browser/browserPathResolver';
import { IInitializeParams } from '../ioc-extras';
import Dap from '../dap/api';

@injectable()
export class SourcePathResolverFactory {
  constructor(
    @inject(AnyLaunchConfiguration) private readonly config: AnyLaunchConfiguration,
    @inject(IInitializeParams) private readonly initializeParams: Dap.InitializeParams,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

  public create() {
    const c = this.config;
    if (
      c.type === DebugType.Node ||
      c.type === DebugType.Terminal ||
      c.type === DebugType.ExtensionHost
    ) {
      return new NodeSourcePathResolver(
        {
          resolveSourceMapLocations: c.resolveSourceMapLocations,
          basePath: c.cwd,
          sourceMapOverrides: c.sourceMapPathOverrides,
          remoteRoot: c.remoteRoot,
          localRoot: c.localRoot,
        },
        this.logger,
      );
    } else {
      return new BrowserSourcePathResolver(
        {
          resolveSourceMapLocations: c.resolveSourceMapLocations,
          baseUrl: baseURL(c),
          localRoot: null,
          remoteRoot: null,
          pathMapping: { '/': c.webRoot, ...c.pathMapping },
          sourceMapOverrides: c.sourceMapPathOverrides,
          clientID: this.initializeParams.clientID,
        },
        this.logger,
      );
    }
  }
}
