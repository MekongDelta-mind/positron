/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2022 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Represents message on an open comm (communications channel)
 *
 * @link https://jupyter-client.readthedocs.io/en/stable/messaging.html#comm-messages
 */
export interface JupyterCommMsg {
	/** The ID of the comm to send the message to (as a GUID) */
	comm_id: string;  // eslint-disable-line

	/** The message payload */
	data: { [key: string]: any };
}
