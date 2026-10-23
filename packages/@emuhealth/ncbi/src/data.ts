// Data for the E-utilities emulator. Genes are real human genes with their NCBI Gene ids, symbols, names, and
// GRCh38 locations as published by NCBI (U.S. government, public domain); the summaries are written for emuhealth.
// PubMed articles are synthetic: PMIDs start at 99000001, which PubMed has not assigned, and DOIs use the 10.5555
// test prefix.

export interface Gene {
  uid: string;
  name: string;
  description: string;
  chromosome: string;
  maplocation: string;
  mim: string[];
  otheraliases: string;
  summary: string;
  genomicinfo: Array<{ chrloc: string; chraccver: string; chrstart: number; chrstop: number; exoncount: number }>;
}

export interface Article {
  uid: string;
  title: string;
  abstract: string;
  authors: string[];
  journal: { title: string; iso: string; issn: string; essn: string };
  year: number;
  month: number;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
  pubtype: string[];
  keywords: string[];
  genes: string[];
}

const gene = (
  uid: string,
  name: string,
  description: string,
  chromosome: string,
  maplocation: string,
  mim: string,
  chraccver: string,
  chrstart: number,
  chrstop: number,
  exoncount: number,
  summary: string,
  otheraliases = "",
): Gene => ({
  uid,
  name,
  description,
  chromosome,
  maplocation,
  mim: [mim],
  otheraliases,
  summary: `${summary} Summary written for emuhealth; see NCBI Gene for the curated record.`,
  genomicinfo: [{ chrloc: chromosome, chraccver, chrstart, chrstop, exoncount }],
});

export const GENES: Gene[] = [
  gene(
    "672",
    "BRCA1",
    "BRCA1 DNA repair associated",
    "17",
    "17q21.31",
    "113705",
    "NC_000017.11",
    43170326,
    43044294,
    31,
    "Tumor suppressor involved in DNA double-strand break repair.",
    "BRCAI, BRCC1, FANCS, RNF53",
  ),
  gene(
    "7157",
    "TP53",
    "tumor protein p53",
    "17",
    "17p13.1",
    "191170",
    "NC_000017.11",
    7687489,
    7668420,
    13,
    "Tumor suppressor that regulates the cell cycle and apoptosis.",
    "P53, LFS1",
  ),
  gene(
    "1956",
    "EGFR",
    "epidermal growth factor receptor",
    "7",
    "7p11.2",
    "131550",
    "NC_000007.14",
    55019016,
    55211627,
    32,
    "Cell surface receptor tyrosine kinase for epidermal growth factor.",
    "ERBB, ERBB1, HER1",
  ),
  gene(
    "3845",
    "KRAS",
    "KRas proto-oncogene, GTPase",
    "12",
    "12p12.1",
    "190070",
    "NC_000012.12",
    25250928,
    25205245,
    7,
    "Small GTPase in the RAS/MAPK signaling pathway.",
    "KRAS2, RASK2",
  ),
  gene(
    "1080",
    "CFTR",
    "CF transmembrane conductance regulator",
    "7",
    "7q31.2",
    "602421",
    "NC_000007.14",
    117480024,
    117668664,
    27,
    "Chloride channel in epithelial cells; variants cause cystic fibrosis.",
    "ABCC7, CF, MRP7",
  ),
  gene(
    "3630",
    "INS",
    "insulin",
    "11",
    "11p15.5",
    "176730",
    "NC_000011.10",
    2161208,
    2159778,
    3,
    "Encodes the hormone insulin, which regulates glucose metabolism.",
    "IDDM2, ILPR",
  ),
  gene(
    "7124",
    "TNF",
    "tumor necrosis factor",
    "6",
    "6p21.33",
    "191160",
    "NC_000006.12",
    31575564,
    31578335,
    4,
    "Proinflammatory cytokine.",
    "DIF, TNFA, TNFSF2",
  ),
  gene(
    "1565",
    "CYP2D6",
    "cytochrome P450 family 2 subfamily D member 6 (gene/pseudogene)",
    "22",
    "22q13.2",
    "124030",
    "NC_000022.11",
    42130809,
    42126498,
    9,
    "Drug metabolizing enzyme; variants change how many medications are processed.",
    "CYP2D, P450DB1",
  ),
  gene(
    "4524",
    "MTHFR",
    "methylenetetrahydrofolate reductase",
    "1",
    "1p36.22",
    "607093",
    "NC_000001.11",
    11805963,
    11785722,
    13,
    "Enzyme in folate metabolism.",
    "",
  ),
  gene(
    "348",
    "APOE",
    "apolipoprotein E",
    "19",
    "19q13.32",
    "107741",
    "NC_000019.10",
    44905795,
    44909392,
    6,
    "Lipid transport protein in plasma and the central nervous system.",
    "AD2, LPG, APO-E",
  ),
];

const JOURNALS = [
  { title: "Journal of Synthetic Medicine", iso: "J Synth Med", issn: "0000-0019", essn: "0000-0027" },
  { title: "Example Clinical Reports", iso: "Example Clin Rep", issn: "0000-0035", essn: "0000-0043" },
  { title: "Placeholder Genomics Letters", iso: "Placeholder Genomics Lett", issn: "0000-0051", essn: "0000-006X" },
];
const SURNAMES = [
  "Garcia",
  "Nguyen",
  "Patel",
  "Johnson",
  "Kim",
  "Okafor",
  "Rossi",
  "Cohen",
  "Silva",
  "Murphy",
  "Haddad",
  "Novak",
];
const INITIALS = ["A", "B", "C", "D", "E", "J", "K", "L", "M", "S"];
const TOPICS = [
  { condition: "hypertension", drug: "lisinopril", genes: ["348"] },
  { condition: "type 2 diabetes", drug: "metformin", genes: ["3630"] },
  { condition: "hyperlipidemia", drug: "atorvastatin", genes: ["348"] },
  { condition: "asthma", drug: "albuterol", genes: ["7124"] },
  { condition: "depression", drug: "sertraline", genes: ["1565"] },
  { condition: "breast cancer", drug: "tamoxifen", genes: ["672", "7157"] },
  { condition: "lung cancer", drug: "erlotinib", genes: ["1956", "3845"] },
  { condition: "cystic fibrosis", drug: "ivacaftor", genes: ["1080"] },
];
const DESIGNS = [
  { pubtype: ["Journal Article", "Randomized Controlled Trial"], phrase: "a randomized controlled trial" },
  { pubtype: ["Journal Article"], phrase: "a retrospective cohort study" },
  { pubtype: ["Journal Article", "Review"], phrase: "a narrative review" },
  { pubtype: ["Journal Article", "Meta-Analysis"], phrase: "a meta-analysis" },
];

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  /** Synthetic PubMed articles, 0 to 5000. Default 80. */
  articles?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
}

export function generateArticles(options: GenerateOptions = {}): Article[] {
  const count = options.articles ?? 80;
  const seed = options.seed ?? 1;
  if (!Number.isInteger(count) || count < 0 || count > 5000)
    throw new Error("ncbi.generate.articles must be an integer from 0 to 5000");
  if (!Number.isInteger(seed)) throw new Error("ncbi.generate.seed must be an integer");
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const articles: Article[] = [];
  for (let n = 1; n <= count; n++) {
    const topic = TOPICS[(n - 1) % TOPICS.length];
    const design = pick(DESIGNS);
    const journal = pick(JOURNALS);
    const authors = Array.from({ length: int(2, 6) }, () => `${pick(SURNAMES)} ${pick(INITIALS)}${pick(INITIALS)}`);
    const title = `${topic.drug[0].toUpperCase()}${topic.drug.slice(1)} in ${topic.condition}: ${design.phrase} (synthetic article ${n}).`;
    const geneNames = topic.genes.map((id) => GENES.find((g) => g.uid === id)!.name);
    articles.push({
      uid: String(99_000_000 + n),
      title,
      abstract: `BACKGROUND: Synthetic abstract generated by emuhealth for local development; it describes no real research. OBJECTIVE: To describe ${topic.drug} in ${topic.condition}. METHODS: ${design.phrase[0].toUpperCase()}${design.phrase.slice(2)} of ${int(40, 4000)} synthetic participants, with attention to ${geneNames.join(" and ")}. CONCLUSIONS: None; the data are synthetic.`,
      authors: [...new Set(authors)],
      journal,
      year: int(2015, 2025),
      month: int(1, 12),
      volume: String(int(1, 60)),
      issue: String(int(1, 12)),
      pages: `${int(1, 400)}-${int(401, 900)}`,
      doi: `10.5555/syn.${99_000_000 + n}`,
      pubtype: design.pubtype,
      keywords: [topic.condition, topic.drug, ...geneNames],
      genes: topic.genes,
    });
  }
  return articles;
}
