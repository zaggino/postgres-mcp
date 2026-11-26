import { describe, expect, it } from "vitest";
import { SequenceHealthCalc } from "../../../src/database-health/sequence-health-calc.ts";

describe("SequenceHealthCalc.parseSequenceName", () => {
  it("parses a simple unquoted sequence name", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('my_seq'::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("my_seq");
  });

  it("parses a sequence with an explicit schema", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('myschema.my_seq'::regclass)"
    );
    expect(schema).toBe("myschema");
    expect(name).toBe("my_seq");
  });

  it("parses an uppercase sequence name quoted by PostgreSQL", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('\"UpperCaseSeq\"'::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("UpperCaseSeq");
  });

  it("parses an uppercase sequence with a schema", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      'nextval(\'"MySchema"."MySeq"\'::regclass)'
    );
    expect(schema).toBe("MySchema");
    expect(name).toBe("MySeq");
  });

  it("parses the text cast format", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval(('my_seq'::text)::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("my_seq");
  });

  it("parses an auto-generated SERIAL sequence name", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('users_id_seq'::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("users_id_seq");
  });

  it("parses the sequence of an uppercase table with a SERIAL column", () => {
    // PostgreSQL generates: "TableName_column_seq"
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('\"UpperCaseOrders_id_seq\"'::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("UpperCaseOrders_id_seq");
  });

  // Known limitation: a literal dot in a sequence name is split as schema.name.
  it.fails("parses a sequence name containing a dot", () => {
    const [schema, name] = SequenceHealthCalc.parseSequenceName(
      "nextval('\"my.seq\"'::regclass)"
    );
    expect(schema).toBe("public");
    expect(name).toBe("my.seq");
  });
});
