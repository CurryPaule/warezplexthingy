/** Ombi v1 API response types for Movie & TV Requests */

export interface OmbiMovieRequest {
  id: number;
  title: string;
  imdbId?: string | null;
  theMovieDbId?: number;
  releaseDate?: string | null;
  digitalReleaseDate?: string | null;
  status?: string | null;
  approved?: boolean;
  approved4K?: boolean;
  available?: boolean;
  available4K?: boolean;
  denied?: boolean | null;
  denied4K?: boolean | null;
  has4KRequest?: boolean;
  is4kRequest?: boolean;
  requestedDate?: string | null;
  requestedUser?: {
    userName?: string;
    alias?: string;
  } | null;
}

export interface OmbiEpisodeRequest {
  id?: number;
  episodeNumber: number;
  title?: string | null;
  airDate?: string | null;
  approved?: boolean;
  available?: boolean;
  denied?: boolean | null;
  requested?: boolean;
}

export interface OmbiSeasonRequest {
  id?: number;
  seasonNumber: number;
  episodes?: OmbiEpisodeRequest[];
}

export interface OmbiChildRequest {
  id?: number;
  approved?: boolean;
  available?: boolean;
  denied?: boolean | null;
  seasonRequests?: OmbiSeasonRequest[];
  requestedUser?: {
    userName?: string;
    alias?: string;
  } | null;
}

export interface OmbiTvRequest {
  id: number;
  title: string;
  imdbId?: string | null;
  tvDbId?: number;
  externalProviderId?: number;
  theMovieDbId?: number;
  releaseDate?: string | null;
  status?: string | null;
  childRequests?: OmbiChildRequest[];
}
