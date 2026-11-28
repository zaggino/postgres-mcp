import { expect, it as test } from 'vitest';

import { getObjectDetails, listObjects } from '../../../src/tools/objects.ts';
import { fakeExecutor } from '../../support/fake-executor.ts';

test('get_object_details gives a constraint without a column no columns and a column without a default a null default', async () => {
  const executor = fakeExecutor((query) => {
    if (query.includes('information_schema.columns')) {
      return [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }];
    }
    if (query.includes('table_constraints')) {
      return [
        { constraint_name: 't_pkey', constraint_type: 'PRIMARY KEY', column_name: 'id' },
        { constraint_name: 't_id_check', constraint_type: 'CHECK', column_name: null },
      ];
    }
    return [];
  });

  const result = await getObjectDetails(executor, 'public', 't', 'table');
  const [content] = result.content;
  const details: unknown = JSON.parse(content?.type === 'text' ? content.text : '');

  expect(details).toMatchObject({
    columns: [{ column: 'id', data_type: 'integer', is_nullable: 'NO', default: null }],
    constraints: [
      { name: 't_pkey', type: 'PRIMARY KEY', columns: ['id'] },
      { name: 't_id_check', type: 'CHECK', columns: [] },
    ],
  });
});

test('list_objects and get_object_details reject an unsupported object type', async () => {
  const executor = fakeExecutor(() => []);

  const listed = await listObjects(executor, 'public', 'index');
  const detailed = await getObjectDetails(executor, 'public', 'i', 'index');

  expect(listed).toMatchObject({ isError: true, content: [{ text: 'Error: Unsupported object type: index' }] });
  expect(detailed).toMatchObject({ isError: true, content: [{ text: 'Error: Unsupported object type: index' }] });
});

test('list_objects lists extensions as name, version and relocatable', async () => {
  const executor = fakeExecutor(() => [{ extname: 'plpgsql', extversion: '1.0', extrelocatable: false }]);

  const result = await listObjects(executor, 'public', 'extension');
  const [content] = result.content;

  expect(JSON.parse(content?.type === 'text' ? content.text : '')).toEqual([
    { name: 'plpgsql', version: '1.0', relocatable: false },
  ]);
});
