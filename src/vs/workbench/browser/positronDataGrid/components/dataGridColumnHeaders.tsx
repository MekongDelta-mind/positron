/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023-2024 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// CSS.
import 'vs/css!./dataGridColumnHeaders';

// React.
import * as React from 'react';

// Other dependencies.
import { usePositronDataGridContext } from 'vs/workbench/browser/positronDataGrid/positronDataGridContext';
import { DataGridColumnHeader } from 'vs/workbench/browser/positronDataGrid/components/dataGridColumnHeader';

// Other dependencies.

/**
 * DataGridColumnHeadersProps interface.
 */
interface DataGridColumnHeadersProps {
	width: number;
	height: number;
}

/**
 * DataGridColumnHeaders component.
 * @param props A DataGridColumnHeadersProps that contains the component properties.
 * @returns The rendered component.
 */
export const DataGridColumnHeaders = (props: DataGridColumnHeadersProps) => {
	// Context hooks.
	const context = usePositronDataGridContext();

	// Create the data grid column headers.
	const dataGridColumnHeaders: JSX.Element[] = [];
	for (
		let columnDescriptor = context.instance.firstColumn;
		columnDescriptor && columnDescriptor.left < context.instance.layoutRight;
		columnDescriptor = context.instance.getColumn(columnDescriptor.columnIndex + 1)
	) {
		dataGridColumnHeaders.push(
			<DataGridColumnHeader
				key={columnDescriptor.columnIndex}
				column={context.instance.column(columnDescriptor.columnIndex)}
				columnIndex={columnDescriptor.columnIndex}
				left={columnDescriptor.left - context.instance.horizontalScrollOffset}
			/>
		);
	}

	// Render.
	return (
		<div className='data-grid-column-headers' style={{ height: props.height }}>
			{dataGridColumnHeaders}
		</div>
	);
};
