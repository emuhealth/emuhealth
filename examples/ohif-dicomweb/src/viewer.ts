// The DICOMweb requests the OHIF Viewer makes for its study list and for opening a study, so the example's test can
// check that the emulator answers each the way OHIF expects.

const DICOM_JSON = "application/dicom+json";

export async function studyList(root: string): Promise<any[]> {
  const params = new URLSearchParams({
    limit: "101",
    offset: "0",
    fuzzymatching: "true",
    includefield: "00081030,00080060",
  });
  const res = await fetch(`${root}/studies?${params}`, { headers: { Accept: DICOM_JSON } });
  if (!res.ok) throw new Error(`QIDO studies returned ${res.status}`);
  return (await res.json()) as any[];
}

export async function seriesOf(root: string, study: string): Promise<any[]> {
  const res = await fetch(`${root}/studies/${study}/series`, { headers: { Accept: DICOM_JSON } });
  if (!res.ok) throw new Error(`QIDO series returned ${res.status}`);
  return (await res.json()) as any[];
}

export async function seriesMetadata(root: string, study: string, series: string): Promise<any[]> {
  const res = await fetch(`${root}/studies/${study}/series/${series}/metadata`, { headers: { Accept: DICOM_JSON } });
  if (!res.ok) throw new Error(`WADO metadata returned ${res.status}`);
  return (await res.json()) as any[];
}

/** One frame as OHIF's image loader asks for it: multipart/related with any transfer syntax. */
export async function frame(root: string, study: string, series: string, instance: string): Promise<Response> {
  return fetch(`${root}/studies/${study}/series/${series}/instances/${instance}/frames/1`, {
    headers: { Accept: "multipart/related; type=application/octet-stream; transfer-syntax=*" },
  });
}

export const value = (item: any, tag: string) => item?.[tag]?.Value?.[0];
