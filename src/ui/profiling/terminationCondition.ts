/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../dap/api';
import { UiProfileSession } from './uiProfileSession';
import { IDisposable } from '../../common/disposable';

/**
 * Item displayed to the user when picking when their profile should end.
 */
export interface ITerminationConditionFactory {
  readonly label: string;
  readonly description?: string;

  /**
   * Called when the user picks this termination factory. Can return undefined
   * to cancel the picking process.
   */
  onPick(): Promise<ITerminationCondition | undefined>;
}

export const ITerminationConditionFactory = Symbol('ITerminationConditionFactory');

export interface ITerminationCondition extends IDisposable {
  /**
   * Custom object to be merged into the `startProfile` request.
   */
  readonly customData?: Partial<Dap.StartProfileParams>;

  /**
   * Called when the profile starts running.
   */
  attachTo(session: UiProfileSession): void;
}
