// OHIF Viewer configuration that reads studies from the emuhealth DICOMweb emulator on http://localhost:4124.
window.config = {
  routerBasename: "/",
  showStudyList: true,
  defaultDataSourceName: "emuhealth",
  dataSources: [
    {
      namespace: "@ohif/extension-default.dataSourcesModule.dicomweb",
      sourceName: "emuhealth",
      configuration: {
        friendlyName: "emuhealth DICOMweb (synthetic)",
        name: "emuhealth",
        qidoRoot: "http://localhost:4124",
        wadoRoot: "http://localhost:4124",
        wadoUriRoot: "http://localhost:4124",
        qidoSupportsIncludeField: true,
        supportsFuzzyMatching: true,
        supportsWildcard: true,
        imageRendering: "wadors",
        thumbnailRendering: "wadors",
        enableStudyLazyLoad: true,
        omitQuotationForMultipartRequest: true,
        bulkDataURI: { enabled: true },
      },
    },
  ],
};
