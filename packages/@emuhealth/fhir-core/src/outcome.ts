// OperationOutcome issue codes used by this package (subset of http://hl7.org/fhir/issue-type).
export type IssueCode =
  | "invalid"
  | "structure"
  | "required"
  | "value"
  | "not-found"
  | "deleted"
  | "not-supported"
  | "conflict"
  | "processing"
  | "exception";

export interface OperationOutcome {
  resourceType: "OperationOutcome";
  issue: Array<{ severity: "fatal" | "error" | "warning" | "information"; code: IssueCode; diagnostics?: string }>;
}

export class FhirError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: IssueCode,
    message: string,
  ) {
    super(message);
    this.name = "FhirError";
  }

  toOutcome(): OperationOutcome {
    return operationOutcome(this.code, this.message);
  }
}

export function operationOutcome(
  code: IssueCode,
  diagnostics: string,
  severity: "fatal" | "error" | "warning" | "information" = "error",
): OperationOutcome {
  return { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics }] };
}
