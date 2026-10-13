export const PRESS_COVERAGE = 'latest-100-captured-metadata' as const;
export const PRESS_CLASSIFICATION = 'clasificación automática del título' as const;
export const PRESS_SAMPLE_LIMIT = 100;
export type PressTopic = 'military' | 'politics' | 'economy' | 'community' | 'other';
export const PRESS_TOPICS: readonly PressTopic[] = ['military', 'politics', 'economy', 'community', 'other'];

export type PressRelated = { id: string; title: string; sharedTopics: Exclude<PressTopic, 'other'>[] };
export type PressArticle = {
  id: string; title: string; countryId: string | null; authorId: string | null;
  publishedAt: string | null; observedAt: string; language: string | null;
  sourceUrl: string; topics: PressTopic[]; related: PressRelated[];
};
export type PressResponse = {
  items: PressArticle[];
  trends: { daily: { date: string; count: number }[]; unknownDateCount: number; topics: { topic: PressTopic; count: number }[] };
  sampled: number; matched: number; limit: number;
  coverage: typeof PRESS_COVERAGE; isSample: true; classification: typeof PRESS_CLASSIFICATION;
};

const keywords: Record<Exclude<PressTopic, 'other'>, ReadonlySet<string>> = {
  military: new Set(['batalla','batallas','guerra','guerras','ataque','ataques','defensa','militar','militares','combate','combates','battle','battles','war','wars','attack','attacks','defense','defence','military','combat']),
  politics: new Set(['eleccion','elecciones','gobierno','congreso','presidente','presidencia','partido','partidos','voto','votos','politica','election','elections','government','congress','president','party','parties','vote','votes','politics']),
  economy: new Set(['economia','mercado','mercados','precio','precios','industria','empresa','empresas','comercio','produccion','economy','market','markets','price','prices','industry','company','companies','trade','production']),
  community: new Set(['comunidad','alianza','alianzas','evento','eventos','entrevista','entrevistas','guia','guias','torneo','torneos','community','alliance','alliances','event','events','interview','interviews','guide','guides','tournament','tournaments']),
};

/** Keyword tags describe only words present in the title, never article claims. */
export function classifyPressTitle(title: string): PressTopic[] {
  const words = new Set(title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z]+/g) ?? []);
  const topics = (['military','politics','economy','community'] as const)
    .filter(topic => [...keywords[topic]].some(word => words.has(word)));
  return topics.length ? topics : ['other'];
}

/** Links titles only when they share an observed, non-generic keyword topic. */
export function relatedPressArticles(article: Pick<PressArticle,'id'|'topics'>, sample: Pick<PressArticle,'id'|'title'|'topics'|'publishedAt'>[], maximum = 6): PressRelated[] {
  return sample.filter(candidate => candidate.id !== article.id).map(candidate => ({ candidate,
    sharedTopics: candidate.topics.filter(topic => topic !== 'other' && article.topics.includes(topic)) as Exclude<PressTopic,'other'>[] }))
    .filter(match => match.sharedTopics.length > 0)
    .sort((left,right) => right.sharedTopics.length-left.sharedTopics.length
      || (right.candidate.publishedAt ?? '').localeCompare(left.candidate.publishedAt ?? '')
      || right.candidate.id.localeCompare(left.candidate.id))
    .slice(0,maximum)
    .map(({candidate,sharedTopics}) => ({ id:candidate.id, title:candidate.title, sharedTopics }));
}
