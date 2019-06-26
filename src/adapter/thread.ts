// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import * as debug from 'debug';
import {Source, Location} from './source';
import * as utils from '../utils';
import {StackTrace, StackFrame} from './stackTrace';
import {Context} from './context';
import * as objectPreview from './objectPreview';

const debugThread = debug('thread');

export type PausedReason = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint';

export interface PausedDetails {
  reason: PausedReason;
  description: string;
  stackTrace: StackTrace;
  text?: string;
};

export class Thread {
  private static _lastThreadId: number = 0;

  private _context: Context;
  private _cdp: Cdp.Api;
  private _state: ('init' | 'normal' | 'disposed') = 'init';
  private _threadId: number;
  private _threadName: string;
  private _threadUrl: string;
  private _pausedDetails?: PausedDetails;
  private _scripts: Map<string, Source> = new Map();

  constructor(context: Context, cdp: Cdp.Api) {
    this._context = context;
    this._cdp = cdp;
    this._threadId = ++Thread._lastThreadId;
    this._threadName = '';
    debugThread(`Thread created #${this._threadId}`);
  }

  context(): Context {
    return this._context;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  threadId(): number {
    return this._threadId;
  }

  threadName(): string {
    return this._threadName;
  }

  pausedDetails(): PausedDetails | undefined {
    return this._pausedDetails;
  }

  async resume(): Promise<boolean> {
    return !!await this._cdp.Debugger.resume({});
  }

  async pause(): Promise<boolean> {
    return !!await this._cdp.Debugger.pause({});
  }

  async stepOver(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOver({});
  }

  async stepInto(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepInto({});
  }

  async stepOut(): Promise<boolean> {
    return !!await this._cdp.Debugger.stepOut({});
  }

  async initialize(): Promise<boolean> {
    const onResumed = () => {
      this._pausedDetails = undefined;
      if (this._state === 'normal')
        this._context.dap.continued({threadId: this._threadId});
    };

    this._cdp.Runtime.on('executionContextsCleared', () => {
      this._removeAllScripts();
      if (this._pausedDetails)
        onResumed();
    });
    this._cdp.Runtime.on('consoleAPICalled', event => {
      if (this._state === 'normal')
        this._onConsoleMessage(event);
    });
    this._cdp.Runtime.on('exceptionThrown', event => {
      if (this._state === 'normal')
        this._onExceptionThrown(event.exceptionDetails);
    });
    if (!await this._cdp.Runtime.enable({}))
      return false;

    this._cdp.Debugger.on('paused', event => {
      this._pausedDetails = this._createPausedDetails(event);
      if (this._state === 'normal')
        this._reportPaused();
    });
    this._cdp.Debugger.on('resumed', onResumed);
    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));
    if (!await this._cdp.Debugger.enable({}))
      return false;
    if (!await this._cdp.Debugger.setAsyncCallStackDepth({maxDepth: 32}))
      return false;

    if (this._state === 'disposed')
      return true;

    this._state = 'normal';
    console.assert(!this._context.threads.has(this._threadId));
    this._context.threads.set(this._threadId, this);
    this._context.dap.thread({reason: 'started', threadId: this._threadId});
    if (this._pausedDetails)
      this._reportPaused();
    return true;
  }

  async dispose() {
    this._removeAllScripts();
    if (this._state === 'normal') {
      console.assert(this._context.threads.get(this._threadId) === this);
      this._context.threads.delete(this._threadId);
      this._context.dap.thread({reason: 'exited', threadId: this._threadId});
    }
    this._state = 'disposed';
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadDetails(threadName: string, threadUrl: string) {
    this._threadName = threadName;
    this._threadUrl = threadUrl;
    debugThread(`Thread renamed #${this._threadId}: ${this._threadName}`);
  }

  locationFromDebuggerCallFrame(callFrame: Cdp.Debugger.CallFrame): Location {
    return {
      url: callFrame.url,
      lineNumber: callFrame.location.lineNumber,
      columnNumber: callFrame.location.columnNumber || 0,
      source: this._scripts.get(callFrame.location.scriptId)
    };
  }

  locationFromRuntimeCallFrame(callFrame: Cdp.Runtime.CallFrame): Location {
    return {
      url: callFrame.url,
      lineNumber: callFrame.lineNumber,
      columnNumber: callFrame.columnNumber,
      source: this._scripts.get(callFrame.scriptId)
    };
  }

  locationFromDebugger(location: Cdp.Debugger.Location): Location {
    const script = this._scripts.get(location.scriptId);
    return {
      url: script ? script.url() : '',
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber || 0,
      source: script
    };
  }

  _reportPaused() {
    const details = this._pausedDetails!;
    this._context.dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this._threadId,
      text: details.text,
      allThreadsStopped: false
    });
  }

  _createPausedDetails(event: Cdp.Debugger.PausedEvent): PausedDetails {
    // TODO(dgozman): fill "text" with more details.
    const stackTrace = StackTrace.fromDebugger(this, event.callFrames, event.asyncStackTrace, event.asyncStackTraceId);
    switch (event.reason) {
      case 'assert': return {stackTrace, reason: 'exception', description: 'Paused on assert'};
      case 'debugCommand': return {stackTrace, reason: 'pause', description: 'Paused on debug() call'};
      case 'DOM': return {stackTrace, reason: 'data breakpoint', description: 'Paused on DOM breakpoint'};
      case 'EventListener': return {stackTrace, reason: 'function breakpoint', description: 'Paused on event listener breakpoint'};
      case 'exception': return {stackTrace, reason: 'exception', description: 'Paused on exception'};
      case 'promiseRejection': return {stackTrace, reason: 'exception', description: 'Paused on promise rejection'};
      case 'instrumentation': return {stackTrace, reason: 'function breakpoint', description: 'Paused on function call'};
      case 'XHR': return {stackTrace, reason: 'data breakpoint', description: 'Paused on XMLHttpRequest or fetch'};
      case 'OOM': return {stackTrace, reason: 'exception', description: 'Paused before Out Of Memory exception'};
      default: return {stackTrace, reason: 'step', description: 'Paused'};
    }
  }

  async _onConsoleMessage(event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<void> {
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this._context.sourceContainer.uiLocation(frames[0].location);
      if (event.type !== 'error' && event.type !== 'warning')
        stackTrace = undefined;
    }

    let category: 'console' | 'stdout' | 'stderr' | 'telemetry' = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';

    const tokens: string[] = [];
    for (const arg of event.args)
      tokens.push(objectPreview.renderValue(arg, false));
    const messageText = tokens.join(' ');

    const allPrimitive = !event.args.find(a => !!a.objectId);
    if (allPrimitive && !stackTrace) {
      this._context.dap.output({
        category,
        output: messageText,
        variablesReference: 0,
        line: uiLocation ? uiLocation.lineNumber : undefined,
        column: uiLocation ? uiLocation.columnNumber : undefined,
      });
      return;
    }

    const variablesReference = await this._context.variableStore.createVariableForMessageFormat(this._cdp, messageText, event.args, stackTrace);
    this._context.dap.output({
      category,
      output: '',
      variablesReference,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
  }

  async _onExceptionThrown(details: Cdp.Runtime.ExceptionDetails): Promise<void> {
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (details.stackTrace)
      stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    const frames: StackFrame[] = stackTrace ? await stackTrace.loadFrames(50) : [];
    if (frames.length)
      uiLocation = this._context.sourceContainer.uiLocation(frames[0].location);
    const description = details.exception && details.exception.description || '';
    let message = description.split('\n').filter(line => !line.startsWith('    at')).join('\n');
    if (stackTrace)
      message += '\n' + (await stackTrace.format());
    this._context.dap.output({
      category: 'stderr',
      output: message,
      variablesReference: 0,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
  }

  _removeAllScripts() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    this._context.sourceContainer.removeSources(...scripts);
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    const readableUrl = event.url || `VM${event.scriptId}`;
    const source = this._context.sourceContainer.createSource(readableUrl, async () => {
      const response = await this._cdp.Debugger.getScriptSource({scriptId: event.scriptId});
      return response ? response.scriptSource : undefined;
    });
    this._scripts.set(event.scriptId, source);
    this._context.sourceContainer.addSource(source);
    if (event.sourceMapURL) {
      // TODO(dgozman): reload source map when target url changes.
      const resolvedSourceUrl = utils.completeUrl(this._threadUrl, event.url);
      const resolvedSourceMapUrl = resolvedSourceUrl && utils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
      if (resolvedSourceMapUrl)
        this._context.sourceContainer.attachSourceMap(source, resolvedSourceMapUrl);
    }
  }
};
