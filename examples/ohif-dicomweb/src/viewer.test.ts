import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmulator } from "emuhealth";
import { frame, seriesMetadata, seriesOf, studyList, value } from "./viewer.ts";

test("answers the study list and viewer requests OHIF makes", async () => {
  const dicomweb = await createEmulator({ service: "dicomweb", port: 0 });
  try {
    const studies = await studyList(dicomweb.url);
    assert.ok(studies.length >= 2);
    const study = value(studies[0], "0020000D");
    assert.ok(study);
    assert.ok(value(studies[0], "00080061"), "ModalitiesInStudy for the study list");

    const series = await seriesOf(dicomweb.url, study);
    const seriesUid = value(series[0], "0020000E");
    const metadata = await seriesMetadata(dicomweb.url, study, seriesUid);
    assert.ok(metadata.length > 0);
    const instance = value(metadata[0], "00080018");
    assert.equal(value(metadata[0], "00280010"), 64, "Rows");
    assert.ok(metadata[0]["7FE00010"]?.BulkDataURI, "pixel data as a BulkDataURI");

    const res = await frame(dicomweb.url, study, seriesUid, instance);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^multipart\/related/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", "CORS for the viewer's origin");
    assert.ok((await res.arrayBuffer()).byteLength > 64 * 64);
  } finally {
    await dicomweb.close();
  }
});
