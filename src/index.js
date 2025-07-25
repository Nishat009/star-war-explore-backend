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

// Delay helper
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Retry helper
async function fetchWithRetry(url, retries = 5, delayMs = 2000) { // Increased retries and delay
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url);
      return response;
    } catch (err) {
      console.error(`Fetch attempt ${i + 1} for ${url} failed:`, err.message, err.response?.status);
      if (err.response?.status === 429 && i < retries - 1) {
        console.warn(`⚠️ Rate limited. Retrying ${url} in ${delayMs}ms...`);
        await delay(delayMs * (i + 1)); // Exponential backoff
      } else {
        throw err;
      }
    }
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
      console.log(`Fetched page with ${data.results?.length} characters, next: ${data.next}`);
      if (data?.results?.length) {
        data.results.forEach((char) => console.log(`Cached character: ${char.url}`));
        results.push(...data.results);
        next = data.next;
      } else {
        next = null;
      }
    }
    allCharacters = results;
    cacheLoaded = true;
    console.log(`✅ Loaded ${allCharacters.length} characters into cache. Full list:`, allCharacters.map(c => c.url));
  } catch (err) {
    console.error('❌ Failed to load characters:', err.message, err.response?.status);
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

    if (!cacheLoaded) {
      await loadAllCharacters();
      if (!cacheLoaded) return res.status(500).json({ error: 'Failed to load characters.' });
    }

    // Filter by search
    let filtered = allCharacters;
    if (search) {
      filtered = allCharacters.filter((char) =>
        char.name.toLowerCase().includes(search)
      );
    }
console.log(`Filtered length: ${filtered.length}, Start: ${start}, End: ${start + pageSize}`);
console.log(`Base list before enrichment:`, baseList.map(c => c.url));
    const totalPages = Math.ceil(filtered.length / pageSize);
    const start = (page - 1) * pageSize;
    const baseList = returnAll ? filtered : filtered.slice(start, start + pageSize);

    const limit = pLimit(5); // Throttle to 5 concurrent fetches

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
              } catch (homeErr) {
                console.warn(`⚠️ Homeworld fetch failed for ${id}: ${homeErr.message}`);
              }
            }

            // Films
            let films = ['Unknown']; // Default to ['Unknown'] if no films
            if (data.films?.length) {
              films = await Promise.all(
                data.films.map((url) =>
                  fetchWithRetry(url)
                    .then((res) => res.data.result.properties.title || 'Unknown')
                    .catch((filmErr) => {
                      console.warn(`⚠️ Film fetch failed for ${url}: ${filmErr.message}`);
                      return 'Unknown';
                    })
                )
              );
            }

            // Species
            let species = 'Unknown';
            if (data.species?.length) {
              try {
                const sp = await fetchWithRetry(data.species[0]);
                species = sp.data.result.properties.name || 'Unknown';
              } catch (spErr) {
                console.warn(`⚠️ Species fetch failed for ${id}: ${spErr.message}`);
              }
            } else {
              try {
                const allSpecies = await fetchWithRetry(`${SWAPI_BASE_URL}/species`);
                for (const sp of allSpecies.data.results) {
                  try {
                    const spDetail = await fetchWithRetry(sp.url);
                    const people = spDetail.data?.result?.properties?.people || [];
                    if (people.some((url) => url.endsWith(`/people/${id}`))) {
                      species = spDetail.data.result.properties.name || 'Unknown';
                      break;
                    }
                  } catch (spDetailErr) {
                    console.warn(`⚠️ Species detail fetch failed for ${sp.url}: ${spDetailErr.message}`);
                  }
                }
              } catch (allSpErr) {
                console.warn(`⚠️ All species fetch failed for ${id}: ${allSpErr.message}`);
              }
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
          } catch (err) {
            console.error(`❌ Error fetching details for character ${id}:`, err.message);
            return {
              uid: id,
              name: char.name || 'Unknown',
              height: 'Unknown',
              mass: 'Unknown',
              homeworld: 'Unknown',
              species: 'Unknown',
              films: ['Unknown'],
            }; // Return partial data on error
          }
        })
      )
    );

    res.json({
      characters: detailed, // Keep all entries, even with partial data
      total_pages: returnAll ? 1 : totalPages,
      next: returnAll ? false : page < totalPages ? `/api/characters?page=${page + 1}` : null,
      previous: returnAll ? false : page > 1 ? `/api/characters?page=${page - 1}` : null,
    });
  } catch (err) {
    console.error('❌ API Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
