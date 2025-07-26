import express from 'express';
import axios from 'axios';
import cors from 'cors';
import pLimit from 'p-limit';

const app = express();
const PORT = 5000;

app.use(cors());

const SWAPI_BASE_URL = 'https://swapi.tech/api';

let allCharacters = [];
let cacheLoaded = false;
let filmCache = {};
let lastLoaded = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

// Delay helper
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Retry helper
async function fetchWithRetry(url, retries = 5, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url);
      return response;
    } catch (err) {
      if (err.response?.status === 429 && i < retries - 1) {
        await delay(delayMs * (i + 1));
      } else {
        throw err;
      }
    }
  }
}
async function loadAllFilms() {
  try {
    const res = await fetchWithRetry(`${SWAPI_BASE_URL}/films`);
    const films = res.data.result || res.data.results;
    if (films && Array.isArray(films)) {
      for (const film of films) {
        const id = film.uid || film.url?.match(/\/films\/(\d+)/)?.[1];
        const title = film.properties?.title;
        if (id && title) {
          filmCache[`${SWAPI_BASE_URL}/films/${id}`] = title;
        }
      }
    }
  } catch (err) {
    console.error('Failed to preload films:', err.message);
  }
}

// Load all character base data
async function loadAllCharacters() {
  try {
    let results = [];
    let next = `${SWAPI_BASE_URL}/people`;
    while (next) {
      const res = await fetchWithRetry(next);
      const data = res.data;
      if (data?.results?.length) {
        results.push(...data.results);
        next = data.next;
      } else {
        next = null;
      }
    }
    allCharacters = results;
    cacheLoaded = true;
  } catch {
    cacheLoaded = false;
  }
}

function extractIdFromUrl(url) {
  const match = url.match(/\/people\/(\d+)/);
  return match ? match[1] : null;
}

app.get('/api/characters', async (req, res) => {
  try {
    const search = req.query.search?.toLowerCase() || '';
    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const returnAll = req.query.all === 'true';

    await loadAllCharacters();
   const now = Date.now();
if (!cacheLoaded || now - lastLoaded > CACHE_DURATION) {
  // Refresh cache
  await loadAllCharacters();
  if (cacheLoaded) {
    lastLoaded = now;
  } else {
    return res.status(500).json({ error: 'Failed to load characters.' });
  }
}

    if (Object.keys(filmCache).length === 0) {
      await loadAllFilms();
    }

    // Filter by search
    let filtered = allCharacters;
    if (search) {
      filtered = allCharacters.filter((char) =>
        char.name.toLowerCase().includes(search)
      );
    }

    const totalPages = Math.ceil(filtered.length / pageSize);
    const start = (page - 1) * pageSize;
    const baseList = returnAll
      ? filtered
      : filtered.slice(start, start + pageSize);

    const limit = pLimit(2);

    const detailed = await Promise.all(
      baseList.map((char) =>
        limit(async () => {
          const id = extractIdFromUrl(char.url);
          try {
            const res = await fetchWithRetry(`${SWAPI_BASE_URL}/people/${id}`);
            const data = res.data.result.properties;

            // Homeworld
            let homeworld = 'Unknown';
            if (data.homeworld) {
              try {
                const homeRes = await fetchWithRetry(data.homeworld);
                homeworld = homeRes.data.result.properties.name || 'Unknown';
              } catch { }
            }

            // Films
            let films = await (async () => {
              const filmsArray = data.films || [];
              if (Array.isArray(filmsArray) && filmsArray.length) {
                return await Promise.all(
                  filmsArray.map(async (filmUrl, index) => {
                    try {
                      const film = await fetchWithRetry(filmUrl);
                      return film.data?.result?.properties?.title || 'Unknown';
                    } catch (err) {
                      console.error(`Film ${index + 1} fetch error: ${filmUrl} - ${err.message}`);
                      return 'Unknown';
                    }
                  })
                );
              } else {
                try {
                  const fallbackFilms = await fetchWithRetry(`${SWAPI_BASE_URL}/films`);
                  const allFilms = fallbackFilms.data?.result || fallbackFilms.data?.results || [];
                  return (
                    allFilms
                      .filter(film =>
                        film.properties?.characters?.some((charUrl) => charUrl.endsWith(`/people/${id}`))
                      )
                      .map(film => film.properties.title) || ['Unknown']
                  );
                } catch (err) {
                  console.error('Fallback films fetch error:', err.message);
                  return ['Unknown'];
                }
              }
            })();


            // Species
            let species = 'Unknown';
            if (data.species?.length) {
              try {
                const sp = await fetchWithRetry(data.species[0]);
                species = sp.data.result.properties.name || 'Unknown';
              } catch { }
            } else {
              try {
                const allSpecies = await fetchWithRetry(
                  `${SWAPI_BASE_URL}/species`
                );
                for (const sp of allSpecies.data.results) {
                  try {
                    const spDetail = await fetchWithRetry(sp.url);
                    const people =
                      spDetail.data?.result?.properties?.people || [];
                    if (people.some((url) => url.endsWith(`/people/${id}`))) {
                      species =
                        spDetail.data.result.properties.name || 'Unknown';
                      break;
                    }
                  } catch { }
                }
              } catch { }
            }

            return {
              uid: id,
              name: data.name || 'Unknown',
              height: data.height || 'Unknown',
              mass: data.mass || 'Unknown',
              homeworld,
              species,
              films,
            };
          } catch {
            return {
              uid: id,
              name: char.name || 'Unknown',
              height: 'Unknown',
              mass: 'Unknown',
              homeworld: 'Unknown',
              species: 'Unknown',
              films: ['Unknown'],
            };
          }
        })
      )
    );

    res.json({
      characters: detailed,
      total_pages: returnAll ? 1 : totalPages,
      next: returnAll
        ? false
        : page < totalPages
          ? `/api/characters?page=${page + 1}`
          : null,
      previous: returnAll
        ? false
        : page > 1
          ? `/api/characters?page=${page - 1}`
          : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
