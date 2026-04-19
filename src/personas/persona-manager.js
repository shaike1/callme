'use strict';
/**
 * Persona Manager
 * Loads bot personas from devices.json
 * Each persona = a 3CX extension + name + personality + voice config
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEVICES_PATH = path.join(__dirname, 'devices.json');

class PersonaManager {
  constructor(devicesPath = DEFAULT_DEVICES_PATH) {
    this.devicesPath = devicesPath;
    this._personas = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.devicesPath)) {
      console.warn(`[PersonaManager] devices.json not found at ${this.devicesPath}, using defaults`);
      this._loadDefaults();
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.devicesPath, 'utf8'));
      for (const d of data) {
        this._personas.set(d.extension, d);
      }
      console.log(`[PersonaManager] Loaded ${this._personas.size} personas`);
    } catch (e) {
      console.error(`[PersonaManager] Failed to load devices.json: ${e.message}`);
      this._loadDefaults();
    }
  }

  _loadDefaults() {
    const defaults = [
      {
        extension: '9000',
        name: 'Callme',
        language: 'he',
        voice: 'he-IL-Wavenet-B',
        systemPrompt: 'אתה עוזר AI שעונה על שאלות בעברית בצורה קצרה וברורה.',
        keywords: ['callme', 'קולמי', 'עזרה', 'help'],
        respondMode: 'keyword',
      },
    ];
    for (const d of defaults) this._personas.set(d.extension, d);
  }

  getByExtension(extension) {
    return this._personas.get(String(extension)) || null;
  }

  getAll() {
    return Array.from(this._personas.values());
  }

  save(persona) {
    this._personas.set(String(persona.extension), persona);
    this._persist();
  }

  _persist() {
    try {
      fs.writeFileSync(this.devicesPath, JSON.stringify(this.getAll(), null, 2));
    } catch (e) {
      console.error(`[PersonaManager] Failed to save: ${e.message}`);
    }
  }
}

module.exports = { PersonaManager };
