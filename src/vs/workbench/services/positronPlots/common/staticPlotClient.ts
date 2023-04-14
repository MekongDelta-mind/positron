/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { IPositronPlotMetadata } from 'vs/workbench/services/languageRuntime/common/languageRuntimePlotClient';
import { ILanguageRuntimeMessageOutput } from 'vs/workbench/services/languageRuntime/common/languageRuntimeService';

/**
 * Creates a static plot client from a language runtime message.
 */
export class StaticPlotClient extends Disposable {
	public readonly metadata: IPositronPlotMetadata;
	public readonly mimeType;
	public readonly data;

	constructor(runtimeId: string, message: ILanguageRuntimeMessageOutput,
		public readonly code?: string) {
		super();

		// Create the metadata for the plot.
		this.metadata = {
			id: message.id,
			parent_id: message.parent_id,
			created: Date.parse(message.when),
			runtime_id: runtimeId,
			code: code ? code : '',
		};

		// Find the image MIME type. This is guaranteed to exist since we only create this object if
		// there is an image, but check anyway to be safe.
		const imageKey = Object.keys(message.data).find(key => key.startsWith('image/'));
		if (!imageKey) {
			throw new Error(`No image/ MIME type found in message data. ` +
				`Found MIME types: ${Object.keys(message.data).join(', ')}`);
		}

		// Save the MIME type and data for the image.
		this.mimeType = imageKey;
		this.data = message.data[imageKey];
	}

	get uri() {
		return `data:${this.mimeType};base64,${this.data}`;
	}

	get id() {
		return this.metadata.id;
	}
}