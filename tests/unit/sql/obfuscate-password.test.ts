import { expect, test } from 'vitest';

import { obfuscatePassword } from '../../../src/sql/sql-driver.ts';

test('obfuscate returns None-equivalents and empty strings unchanged', () => {
  expect(obfuscatePassword('')).toBe('');
  expect(obfuscatePassword(null)).toBeNull();
});

test('obfuscate masks the password in PostgreSQL URLs', () => {
  expect(obfuscatePassword('postgresql://user:secret@localhost:5432/mydatabase')).toBe(
    'postgresql://user:****@localhost:5432/mydatabase'
  );

  const special = obfuscatePassword('postgresql://user:p@$$w0rd@localhost:5432/mydatabase');
  expect(special).not.toContain('p@$$w0rd');
  expect(special).toContain('****');

  const withQuery = obfuscatePassword('postgresql://user:secret@localhost:5432/mydatabase?sslmode=require');
  expect(withQuery).not.toContain('secret');
  expect(withQuery).toContain('?sslmode=require');
});

test('obfuscate masks URLs inside error messages', () => {
  const errorMessage =
    'Failed to connect: could not connect to server: Connection refused. Is the server ' +
    "running on host 'localhost' (127.0.0.1) and accepting TCP/IP connections on port 5432? " +
    'connection string: postgresql://admin:topsecret@localhost:5432/mydb';
  const obfuscated = obfuscatePassword(errorMessage);
  expect(obfuscated).not.toContain('topsecret');
  expect(obfuscated).toContain('postgresql://admin:****@localhost:5432/mydb');
});

test('obfuscate masks password connection parameters', () => {
  const keyValue = obfuscatePassword('host=localhost port=5432 dbname=mydb user=admin password=secret123');
  expect(keyValue).not.toContain('secret123');
  expect(keyValue).toContain('password=****');

  const quoted = obfuscatePassword(
    `conn = psycopg.connect("host=localhost dbname=mydb user=postgres password='my$3cret!'")`
  );
  expect(quoted).not.toContain('my$3cret!');
  expect(quoted).toContain("password='****'");
});

test('obfuscate masks every password when several URLs are present', () => {
  const obfuscated = obfuscatePassword(`
    Primary DB: postgresql://user1:password1@host1:5432/db1
    Secondary DB: postgresql://user2:password2@host2:5432/db2
    `);
  expect(obfuscated).not.toContain('password1');
  expect(obfuscated).not.toContain('password2');
  expect(obfuscated).toContain('user1:****@');
  expect(obfuscated).toContain('user2:****@');
});

test('obfuscate leaves strings without sensitive data unchanged', () => {
  const text = 'This is a normal string with no passwords.';
  expect(obfuscatePassword(text)).toBe(text);

  const url = 'http://example.com/path';
  expect(obfuscatePassword(url)).toBe(url);
});

test('obfuscate masks DSN passwords in single and double quotes', () => {
  const single = obfuscatePassword("host='localhost' user='postgres' password='supersecret' dbname='testdb'");
  expect(single).not.toContain('supersecret');
  expect(single).toContain("password='****'");

  const double = obfuscatePassword('host="localhost" user="postgres" password="supersecret" dbname="testdb"');
  expect(double).not.toContain('supersecret');
  expect(double).toContain('password="****"');
});
