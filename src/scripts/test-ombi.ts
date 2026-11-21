/**
 * Test script: Ombi connectivity & dry-run preview
 *
 * Fetches movie and TV requests from Ombi and prints how each request
 * evaluates against release-date gating and default watchlist filters.
 * Does NOT write to NocoDB.
 *
 * Usage:
 *   npm run test:ombi
 */

import { loadConfig } from '../config';
import { OmbiClient } from '../ombi/client';
import {
  evaluateMovieRequest,
  evaluateTvRequest,
  computeDesiredActive,
  buildNewWatchlistRow,
} from '../scrapers/ombi-sync';

async function main() {
  const config = loadConfig();

  if (!config.OMBI_URL || !config.OMBI_API_KEY) {
    console.error('❌ OMBI_URL and OMBI_API_KEY must be set in .env');
    process.exit(1);
  }

  const client = new OmbiClient(config);
  const now = new Date();

  console.log(`\n🔗 Ombi: ${config.OMBI_URL}`);
  console.log(
    `⚙️  Defaults: Quality=${config.DEFAULT_QUALITY || 'any'}, Lang=${config.DEFAULT_LANG || 'any'}, Tags=${config.DEFAULT_TAGS || '(none)'}`,
  );
  console.log(
    `📅 Lookahead: Movie digital=${config.OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS}d, Series airDate=${config.OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS}d\n`,
  );

  process.stdout.write('Checking Ombi status… ');
  const status = await client.getStatus();
  console.log(`✅  ${status || 'OK'}`);

  process.stdout.write('Fetching movie requests… ');
  const movies = await client.getMovieRequests();
  console.log(`✅  ${movies.length} movie request(s)`);

  process.stdout.write('Fetching TV requests… ');
  const tvShows = await client.getTvRequests();
  console.log(`✅  ${tvShows.length} TV request(s)\n`);

  if (movies.length > 0) {
    console.log('🎬 Movies:');
    for (const m of movies) {
      const desired = evaluateMovieRequest(m, now, config.OMBI_MOVIE_DIGITAL_LOOKAHEAD_DAYS);
      const active = computeDesiredActive(desired);
      const row = buildNewWatchlistRow(desired, config);
      const state = !desired.isApproved
        ? 'UNAPPROVED/DENIED'
        : desired.isAvailable
          ? 'AVAILABLE (skip/deactivate)'
          : active
            ? 'ACTIVE'
            : `INACTIVE (unreleased, ${desired.releaseDateLabel ?? 'tbd'})`;
      const id = desired.imdbId ? `IMDB:${desired.imdbId}` : desired.tmdbId ? `TMDB:${desired.tmdbId}` : 'no-id';
      console.log(`  - ${desired.title} [${id}] | Q:${row.Quality || 'any'} | Lang:${row.LangRequired || 'any'} → ${state}`);
    }
    console.log();
  }

  if (tvShows.length > 0) {
    console.log('📺 TV Show Seasons:');
    for (const tv of tvShows) {
      const seasons = evaluateTvRequest(tv, now, config.OMBI_SERIES_AIRDATE_LOOKAHEAD_DAYS);
      if (seasons.length === 0) {
        console.log(`  - ${tv.title} → (no approved seasons)`);
        continue;
      }
      for (const desired of seasons) {
        const active = computeDesiredActive(desired);
        const row = buildNewWatchlistRow(desired, config);
        const sLabel = `S${String(desired.season ?? 0).padStart(2, '0')}`;
        const state = desired.isAvailable
          ? 'AVAILABLE (skip/deactivate)'
          : active
            ? `ACTIVE (seed LastEp=${desired.initialLastEpisodeFound ?? 0}, maxEp=${desired.highestRequestedEpisode ?? '?'})`
            : `INACTIVE (premieres ${desired.releaseDateLabel ?? 'tbd'})`;
        const id = desired.imdbId ? `IMDB:${desired.imdbId}` : 'no-id';
        console.log(`  - ${desired.title} ${sLabel} [${id}] | Q:${row.Quality || 'any'} | Lang:${row.LangRequired || 'any'} → ${state}`);
      }
    }
    console.log();
  }

  console.log('✅ Ombi dry-run completed.\n');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
