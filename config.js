// Central configuration for Vending Survey PWA.
// Edit PRESET_TAGS, PHOTO_ROLES, or GOOGLE_OAUTH_CLIENT_ID here.

export const APP_CONFIG = {
  appName: 'Vending Survey',
  schemaVersion: 1,

  // Paste your Google Cloud OAuth 2.0 Web Client ID here (or set it in Settings).
  // Never put a client secret in frontend code.
  googleOAuthClientId: '728765924759-blkp0ul3immq0bippl9enqtcvg2kuhea.apps.googleusercontent.com',
  driveScope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
  driveRootFolderName: 'Vending Survey',

  // Trusted developer emails (pins appear solid black; no age/sex prompt)
  developerEmails: [
    'mindsoffire@gmail.com',
    'taylorf.joy@gmail.com',
    'muse.vanya@gmail.com'
  ],

  // Community contributor profile options (18+, 5 brackets)
  ageRanges: ['18–24', '25–34', '35–44', '45–54', '55+'],
  sexOptions: ['Female', 'Male', 'Prefer not to say'],

  // Singapore map defaults
  mapCenter: [1.3521, 103.8198],
  mapDefaultZoom: 12,
  nearbyRadiusMetres: 100,

  // Default photo resize & compression settings (also editable in Settings)
  defaultSettings: {
    photoMaxSide: 1600,
    photoQuality: 0.78,
    photoFormat: 'image/jpeg',
    developerMode: false,
    basemap: 'osm', // 'osm' | 'onemap'
    workingSetLimit: 25
  },

  // Fixed photo role buttons (easy to extend here later)
  photoRoles: [
    'Front',
    'Shelf 1',
    'Shelf 2',
    'Shelf 3',
    'Shelf 4',
    'Shelf 5',
    'Shelf 6',
    'Shelf 7',
    'Shelf 8',
    'Payment 1',
    'Payment 2',
    'Instructions',
    'Contact'
  ],

  // Payment preset tag chips (shown when Payment 1 or Payment 2 is selected)
  paymentTags: ['cash', 'coins', 'NETS', 'PayNow', 'card', 'EZ-Link'],

  // Preset product tag chips
  presetTags: [
    'snacks',
    'cold drinks',
    'hot drinks',
    'juice',
    'sugarcane',
    'fresh fruit',
    'durian',
    'noodles',
    'ice cream',
    'personal care',
    'other'
  ],

  // Machine status options (default is always 'Unknown / Not checked')
  machineStatuses: [
    'Unknown / Not checked',
    'Working',
    'Broken',
    'Gone'
  ],

  // Small local word list for gentle custom-tag spellcheck suggestions
  spellcheckDictionary: [
    'snacks', 'drinks', 'coffee', 'tea', 'matcha', 'juice', 'sugarcane',
    'coconut', 'water', 'milk', 'soy', 'soda', 'cola', 'isotonic',
    'fruit', 'durian', 'mango', 'apple', 'orange', 'noodles', 'ramen',
    'bento', 'sandwich', 'bread', 'pastry', 'cake', 'ice cream', 'gelato',
    'chocolate', 'chips', 'crisps', 'biscuits', 'cookies', 'nuts',
    'mask', 'tissue', 'sanitiser', 'sanitizer', 'umbrella', 'charger',
    'cable', 'powerbank', 'medicine', 'personal care', 'toiletry',
    'halal', 'vegetarian', 'vegan', 'protein', 'energy', 'flowers', 'toys',
    'cash', 'coins', 'nets', 'paynow', 'card', 'credit', 'ez-link', 'contactless', 'apple pay', 'google pay'
  ]
};
