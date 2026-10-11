UPDATE source_registry SET endpoint='country.getAllCountries + country.getCountryById' WHERE id='countries';
UPDATE source_registry SET endpoint='region.getRegionsObject + region.getById' WHERE id='regions';
