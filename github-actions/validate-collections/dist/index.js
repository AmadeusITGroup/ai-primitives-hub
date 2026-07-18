#!/usr/bin/env node
import fs$1 from 'fs';
import path$1 from 'path';
import require$$0 from 'node:fs';
import require$$1 from 'node:path';

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

var dist = {};

var validate = {};

var jsYaml = {};

var loader$1 = {};

var common$5 = {};

function isNothing (subject) {
  return (typeof subject === 'undefined') || (subject === null)
}

function isObject (subject) {
  return (typeof subject === 'object') && (subject !== null)
}

function toArray (sequence) {
  if (Array.isArray(sequence)) return sequence
  else if (isNothing(sequence)) return []

  return [sequence]
}

function extend (target, source) {
  if (source) {
    const sourceKeys = Object.keys(source);

    for (let index = 0, length = sourceKeys.length; index < length; index += 1) {
      const key = sourceKeys[index];
      target[key] = source[key];
    }
  }

  return target
}

function repeat (string, count) {
  let result = '';

  for (let cycle = 0; cycle < count; cycle += 1) {
    result += string;
  }

  return result
}

function isNegativeZero (number) {
  return (number === 0) && (Number.NEGATIVE_INFINITY === 1 / number)
}

common$5.isNothing = isNothing;
common$5.isObject = isObject;
common$5.toArray = toArray;
common$5.repeat = repeat;
common$5.isNegativeZero = isNegativeZero;
common$5.extend = extend;

function formatError (exception, compact) {
  let where = '';
  const message = exception.reason || '(unknown reason)';

  if (!exception.mark) return message

  if (exception.mark.name) {
    where += 'in "' + exception.mark.name + '" ';
  }

  where += '(' + (exception.mark.line + 1) + ':' + (exception.mark.column + 1) + ')';

  if (!compact && exception.mark.snippet) {
    where += '\n\n' + exception.mark.snippet;
  }

  return message + ' ' + where
}

function YAMLException$4 (reason, mark) {
  // Super constructor
  Error.call(this);

  this.name = 'YAMLException';
  this.reason = reason;
  this.mark = mark;
  this.message = formatError(this, false);

  // Include stack trace in error object
  if (Error.captureStackTrace) {
    // Chrome and NodeJS
    Error.captureStackTrace(this, this.constructor);
  } else {
    // FF, IE 10+ and Safari 6+. Fallback for others
    this.stack = (new Error()).stack || '';
  }
}

// Inherit from Error
YAMLException$4.prototype = Object.create(Error.prototype);
YAMLException$4.prototype.constructor = YAMLException$4;

YAMLException$4.prototype.toString = function toString (compact) {
  return this.name + ': ' + formatError(this, compact)
};

var exception = YAMLException$4;

const common$4 = common$5;

// get snippet for a single line, respecting maxLength
function getLine (buffer, lineStart, lineEnd, position, maxLineLength) {
  let head = '';
  let tail = '';
  const maxHalfLength = Math.floor(maxLineLength / 2) - 1;

  if (position - lineStart > maxHalfLength) {
    head = ' ... ';
    lineStart = position - maxHalfLength + head.length;
  }

  if (lineEnd - position > maxHalfLength) {
    tail = ' ...';
    lineEnd = position + maxHalfLength - tail.length;
  }

  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, '→') + tail,
    pos: position - lineStart + head.length // relative position
  }
}

function padStart (string, max) {
  return common$4.repeat(' ', max - string.length) + string
}

function makeSnippet$1 (mark, options) {
  options = Object.create(options || null);

  if (!mark.buffer) return null

  if (!options.maxLength) options.maxLength = 79;
  if (typeof options.indent !== 'number') options.indent = 1;
  if (typeof options.linesBefore !== 'number') options.linesBefore = 3;
  if (typeof options.linesAfter !== 'number') options.linesAfter = 2;

  const re = /\r?\n|\r|\0/g;
  const lineStarts = [0];
  const lineEnds = [];
  let match;
  let foundLineNo = -1;

  while ((match = re.exec(mark.buffer))) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);

    if (mark.position <= match.index && foundLineNo < 0) {
      foundLineNo = lineStarts.length - 2;
    }
  }

  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;

  let result = '';
  const lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
  const maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);

  for (let i = 1; i <= options.linesBefore; i++) {
    if (foundLineNo - i < 0) break
    const line = getLine(
      mark.buffer,
      lineStarts[foundLineNo - i],
      lineEnds[foundLineNo - i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]),
      maxLineLength
    );
    result = common$4.repeat(' ', options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) +
      ' | ' + line.str + '\n' + result;
  }

  const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += common$4.repeat(' ', options.indent) + padStart((mark.line + 1).toString(), lineNoLength) +
    ' | ' + line.str + '\n';
  result += common$4.repeat('-', options.indent + lineNoLength + 3 + line.pos) + '^' + '\n';

  for (let i = 1; i <= options.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break
    const line = getLine(
      mark.buffer,
      lineStarts[foundLineNo + i],
      lineEnds[foundLineNo + i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]),
      maxLineLength
    );
    result += common$4.repeat(' ', options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) +
      ' | ' + line.str + '\n';
  }

  return result.replace(/\n$/, '')
}

var snippet = makeSnippet$1;

const YAMLException$3 = exception;

const TYPE_CONSTRUCTOR_OPTIONS = [
  'kind',
  'multi',
  'resolve',
  'construct',
  'instanceOf',
  'predicate',
  'represent',
  'representName',
  'defaultStyle',
  'styleAliases'
];

const YAML_NODE_KINDS = [
  'scalar',
  'sequence',
  'mapping'
];

function compileStyleAliases (map) {
  const result = {};

  if (map !== null) {
    Object.keys(map).forEach(function (style) {
      map[style].forEach(function (alias) {
        result[String(alias)] = style;
      });
    });
  }

  return result
}

function Type$e (tag, options) {
  options = options || {};

  Object.keys(options).forEach(function (name) {
    if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
      throw new YAMLException$3('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.')
    }
  });

  // TODO: Add tag format check.
  this.options = options; // keep original options in case user wants to extend this type later
  this.tag = tag;
  this.kind = options['kind'] || null;
  this.resolve = options['resolve'] || function () { return true };
  this.construct = options['construct'] || function (data) { return data };
  this.instanceOf = options['instanceOf'] || null;
  this.predicate = options['predicate'] || null;
  this.represent = options['represent'] || null;
  this.representName = options['representName'] || null;
  this.defaultStyle = options['defaultStyle'] || null;
  this.multi = options['multi'] || false;
  this.styleAliases = compileStyleAliases(options['styleAliases'] || null);

  if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
    throw new YAMLException$3('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.')
  }
}

var type = Type$e;

const YAMLException$2 = exception;
const Type$d = type;

function compileList (schema, name) {
  const result = [];

  schema[name].forEach(function (currentType) {
    let newIndex = result.length;

    result.forEach(function (previousType, previousIndex) {
      if (previousType.tag === currentType.tag &&
          previousType.kind === currentType.kind &&
          previousType.multi === currentType.multi) {
        newIndex = previousIndex;
      }
    });

    result[newIndex] = currentType;
  });

  return result
}

function compileMap (/* lists... */) {
  const result = {
    scalar: {},
    sequence: {},
    mapping: {},
    fallback: {},
    multi: {
      scalar: [],
      sequence: [],
      mapping: [],
      fallback: []
    }
  };
  function collectType (type) {
    if (type.multi) {
      result.multi[type.kind].push(type);
      result.multi['fallback'].push(type);
    } else {
      result[type.kind][type.tag] = result['fallback'][type.tag] = type;
    }
  }

  for (let index = 0, length = arguments.length; index < length; index += 1) {
    arguments[index].forEach(collectType);
  }
  return result
}

function Schema$1 (definition) {
  return this.extend(definition)
}

Schema$1.prototype.extend = function extend (definition) {
  let implicit = [];
  let explicit = [];

  if (definition instanceof Type$d) {
    // Schema.extend(type)
    explicit.push(definition);
  } else if (Array.isArray(definition)) {
    // Schema.extend([ type1, type2, ... ])
    explicit = explicit.concat(definition);
  } else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
    // Schema.extend({ explicit: [ type1, type2, ... ], implicit: [ type1, type2, ... ] })
    if (definition.implicit) implicit = implicit.concat(definition.implicit);
    if (definition.explicit) explicit = explicit.concat(definition.explicit);
  } else {
    throw new YAMLException$2('Schema.extend argument should be a Type, [ Type ], ' +
      'or a schema definition ({ implicit: [...], explicit: [...] })')
  }

  implicit.forEach(function (type) {
    if (!(type instanceof Type$d)) {
      throw new YAMLException$2('Specified list of YAML types (or a single Type object) contains a non-Type object.')
    }

    if (type.loadKind && type.loadKind !== 'scalar') {
      throw new YAMLException$2('There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.')
    }

    if (type.multi) {
      throw new YAMLException$2('There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.')
    }
  });

  explicit.forEach(function (type) {
    if (!(type instanceof Type$d)) {
      throw new YAMLException$2('Specified list of YAML types (or a single Type object) contains a non-Type object.')
    }
  });

  const result = Object.create(Schema$1.prototype);

  result.implicit = (this.implicit || []).concat(implicit);
  result.explicit = (this.explicit || []).concat(explicit);

  result.compiledImplicit = compileList(result, 'implicit');
  result.compiledExplicit = compileList(result, 'explicit');
  result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);

  return result
};

var schema = Schema$1;

const Type$c = type;

var str = new Type$c('tag:yaml.org,2002:str', {
  kind: 'scalar',
  construct: function (data) { return data !== null ? data : '' }
});

const Type$b = type;

var seq = new Type$b('tag:yaml.org,2002:seq', {
  kind: 'sequence',
  construct: function (data) { return data !== null ? data : [] }
});

const Type$a = type;

var map = new Type$a('tag:yaml.org,2002:map', {
  kind: 'mapping',
  construct: function (data) { return data !== null ? data : {} }
});

const Schema = schema;

var failsafe = new Schema({
  explicit: [
    str,
    seq,
    map
  ]
});

const Type$9 = type;

function resolveYamlNull (data) {
  if (data === null) return true

  const max = data.length;

  return (max === 1 && data === '~') ||
         (max === 4 && (data === 'null' || data === 'Null' || data === 'NULL'))
}

function constructYamlNull () {
  return null
}

function isNull (object) {
  return object === null
}

var _null = new Type$9('tag:yaml.org,2002:null', {
  kind: 'scalar',
  resolve: resolveYamlNull,
  construct: constructYamlNull,
  predicate: isNull,
  represent: {
    canonical: function () { return '~' },
    lowercase: function () { return 'null' },
    uppercase: function () { return 'NULL' },
    camelcase: function () { return 'Null' },
    empty: function () { return '' }
  },
  defaultStyle: 'lowercase'
});

const Type$8 = type;

function resolveYamlBoolean (data) {
  if (data === null) return false

  const max = data.length;

  return (max === 4 && (data === 'true' || data === 'True' || data === 'TRUE')) ||
         (max === 5 && (data === 'false' || data === 'False' || data === 'FALSE'))
}

function constructYamlBoolean (data) {
  return data === 'true' ||
         data === 'True' ||
         data === 'TRUE'
}

function isBoolean (object) {
  return Object.prototype.toString.call(object) === '[object Boolean]'
}

var bool = new Type$8('tag:yaml.org,2002:bool', {
  kind: 'scalar',
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function (object) { return object ? 'true' : 'false' },
    uppercase: function (object) { return object ? 'TRUE' : 'FALSE' },
    camelcase: function (object) { return object ? 'True' : 'False' }
  },
  defaultStyle: 'lowercase'
});

const common$3 = common$5;
const Type$7 = type;

function isHexCode (c) {
  return ((c >= 0x30/* 0 */) && (c <= 0x39/* 9 */)) ||
         ((c >= 0x41/* A */) && (c <= 0x46/* F */)) ||
         ((c >= 0x61/* a */) && (c <= 0x66/* f */))
}

function isOctCode (c) {
  return ((c >= 0x30/* 0 */) && (c <= 0x37/* 7 */))
}

function isDecCode (c) {
  return ((c >= 0x30/* 0 */) && (c <= 0x39/* 9 */))
}

function resolveYamlInteger (data) {
  if (data === null) return false

  const max = data.length;
  let index = 0;
  let hasDigits = false;

  if (!max) return false

  let ch = data[index];

  // sign
  if (ch === '-' || ch === '+') {
    ch = data[++index];
  }

  if (ch === '0') {
    // 0
    if (index + 1 === max) return true
    ch = data[++index];

    // base 2, base 8, base 16

    if (ch === 'b') {
      // base 2
      index++;

      for (; index < max; index++) {
        ch = data[index];
        if (ch !== '0' && ch !== '1') return false
        hasDigits = true;
      }
      return hasDigits && isFinite(parseYamlInteger(data))
    }

    if (ch === 'x') {
      // base 16
      index++;

      for (; index < max; index++) {
        if (!isHexCode(data.charCodeAt(index))) return false
        hasDigits = true;
      }
      return hasDigits && isFinite(parseYamlInteger(data))
    }

    if (ch === 'o') {
      // base 8
      index++;

      for (; index < max; index++) {
        if (!isOctCode(data.charCodeAt(index))) return false
        hasDigits = true;
      }
      return hasDigits && isFinite(parseYamlInteger(data))
    }
  }

  // base 10 (except 0)

  for (; index < max; index++) {
    if (!isDecCode(data.charCodeAt(index))) {
      return false
    }
    hasDigits = true;
  }

  if (!hasDigits) return false

  return isFinite(parseYamlInteger(data))
}

function parseYamlInteger (data) {
  let value = data;
  let sign = 1;

  let ch = value[0];

  if (ch === '-' || ch === '+') {
    if (ch === '-') sign = -1;
    value = value.slice(1);
    ch = value[0];
  }

  if (value === '0') return 0

  if (ch === '0') {
    if (value[1] === 'b') return sign * parseInt(value.slice(2), 2)
    if (value[1] === 'x') return sign * parseInt(value.slice(2), 16)
    if (value[1] === 'o') return sign * parseInt(value.slice(2), 8)
  }

  return sign * parseInt(value, 10)
}

function constructYamlInteger (data) {
  return parseYamlInteger(data)
}

function isInteger (object) {
  return (Object.prototype.toString.call(object)) === '[object Number]' &&
         (object % 1 === 0 && !common$3.isNegativeZero(object))
}

var int = new Type$7('tag:yaml.org,2002:int', {
  kind: 'scalar',
  resolve: resolveYamlInteger,
  construct: constructYamlInteger,
  predicate: isInteger,
  represent: {
    binary: function (obj) { return obj >= 0 ? '0b' + obj.toString(2) : '-0b' + obj.toString(2).slice(1) },
    octal: function (obj) { return obj >= 0 ? '0o' + obj.toString(8) : '-0o' + obj.toString(8).slice(1) },
    decimal: function (obj) { return obj.toString(10) },
    hexadecimal: function (obj) { return obj >= 0 ? '0x' + obj.toString(16).toUpperCase() : '-0x' + obj.toString(16).toUpperCase().slice(1) }
  },
  defaultStyle: 'decimal',
  styleAliases: {
    binary: [2, 'bin'],
    octal: [8, 'oct'],
    decimal: [10, 'dec'],
    hexadecimal: [16, 'hex']
  }
});

const common$2 = common$5;
const Type$6 = type;

const YAML_FLOAT_PATTERN = new RegExp(
  // 2.5e4, 2.5 and integers
  '^(?:[-+]?(?:[0-9]+)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?' +
  // .2e4, .2
  // special case, seems not from spec
  '|\\.[0-9]+(?:[eE][-+]?[0-9]+)?' +
  // .inf
  '|[-+]?\\.(?:inf|Inf|INF)' +
  // .nan
  '|\\.(?:nan|NaN|NAN))$');

const YAML_FLOAT_SPECIAL_PATTERN = new RegExp(
  '^(?:' +
  // .inf
  '[-+]?\\.(?:inf|Inf|INF)' +
  // .nan
  '|\\.(?:nan|NaN|NAN))$');

function resolveYamlFloat (data) {
  if (data === null) return false

  if (!YAML_FLOAT_PATTERN.test(data)) {
    return false
  }

  if (isFinite(parseFloat(data, 10))) {
    return true
  }

  return YAML_FLOAT_SPECIAL_PATTERN.test(data)
}

function constructYamlFloat (data) {
  let value = data.toLowerCase();
  const sign = value[0] === '-' ? -1 : 1;

  if ('+-'.indexOf(value[0]) >= 0) {
    value = value.slice(1);
  }

  if (value === '.inf') {
    return (sign === 1) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  } else if (value === '.nan') {
    return NaN
  }
  return sign * parseFloat(value, 10)
}

const SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;

function representYamlFloat (object, style) {
  if (isNaN(object)) {
    switch (style) {
      case 'lowercase': return '.nan'
      case 'uppercase': return '.NAN'
      case 'camelcase': return '.NaN'
    }
  } else if (Number.POSITIVE_INFINITY === object) {
    switch (style) {
      case 'lowercase': return '.inf'
      case 'uppercase': return '.INF'
      case 'camelcase': return '.Inf'
    }
  } else if (Number.NEGATIVE_INFINITY === object) {
    switch (style) {
      case 'lowercase': return '-.inf'
      case 'uppercase': return '-.INF'
      case 'camelcase': return '-.Inf'
    }
  } else if (common$2.isNegativeZero(object)) {
    return '-0.0'
  }

  const res = object.toString(10);

  // JS stringifier can build scientific format without dots: 5e-100,
  // while YAML requres dot: 5.e-100. Fix it with simple hack

  return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace('e', '.e') : res
}

function isFloat (object) {
  return (Object.prototype.toString.call(object) === '[object Number]') &&
         (object % 1 !== 0 || common$2.isNegativeZero(object))
}

var float = new Type$6('tag:yaml.org,2002:float', {
  kind: 'scalar',
  resolve: resolveYamlFloat,
  construct: constructYamlFloat,
  predicate: isFloat,
  represent: representYamlFloat,
  defaultStyle: 'lowercase'
});

var json = failsafe.extend({
  implicit: [
    _null,
    bool,
    int,
    float
  ]
});

var core = json;

const Type$5 = type;

const YAML_DATE_REGEXP = new RegExp(
  '^([0-9][0-9][0-9][0-9])' + // [1] year
  '-([0-9][0-9])' + // [2] month
  '-([0-9][0-9])$');                   // [3] day

const YAML_TIMESTAMP_REGEXP = new RegExp(
  '^([0-9][0-9][0-9][0-9])' + // [1] year
  '-([0-9][0-9]?)' + // [2] month
  '-([0-9][0-9]?)' + // [3] day
  '(?:[Tt]|[ \\t]+)' + // ...
  '([0-9][0-9]?)' + // [4] hour
  ':([0-9][0-9])' + // [5] minute
  ':([0-9][0-9])' + // [6] second
  '(?:\\.([0-9]*))?' + // [7] fraction
  '(?:[ \\t]*(Z|([-+])([0-9][0-9]?)' + // [8] tz [9] tz_sign [10] tzHour
  '(?::([0-9][0-9]))?))?$');           // [11] tzMinute

function resolveYamlTimestamp (data) {
  if (data === null) return false
  if (YAML_DATE_REGEXP.exec(data) !== null) return true
  if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true
  return false
}

function constructYamlTimestamp (data) {
  let fraction = 0;
  let delta = null;

  let match = YAML_DATE_REGEXP.exec(data);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);

  if (match === null) throw new Error('Date resolve error')

  // match: [1] year [2] month [3] day

  const year = +(match[1]);
  const month = +(match[2]) - 1; // JS month starts with 0
  const day = +(match[3]);

  if (!match[4]) { // no hour
    return new Date(Date.UTC(year, month, day))
  }

  // match: [4] hour [5] minute [6] second [7] fraction

  const hour = +(match[4]);
  const minute = +(match[5]);
  const second = +(match[6]);

  if (match[7]) {
    fraction = match[7].slice(0, 3);
    while (fraction.length < 3) { // milli-seconds
      fraction += '0';
    }
    fraction = +fraction;
  }

  // match: [8] tz [9] tz_sign [10] tzHour [11] tzMinute

  if (match[9]) {
    const tzHour = +(match[10]);
    const tzMinute = +(match[11] || 0);
    delta = (tzHour * 60 + tzMinute) * 60000; // delta in mili-seconds
    if (match[9] === '-') delta = -delta;
  }

  const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));

  if (delta) date.setTime(date.getTime() - delta);

  return date
}

function representYamlTimestamp (object /*, style */) {
  return object.toISOString()
}

var timestamp = new Type$5('tag:yaml.org,2002:timestamp', {
  kind: 'scalar',
  resolve: resolveYamlTimestamp,
  construct: constructYamlTimestamp,
  instanceOf: Date,
  represent: representYamlTimestamp
});

const Type$4 = type;

function resolveYamlMerge (data) {
  return data === '<<' || data === null
}

var merge = new Type$4('tag:yaml.org,2002:merge', {
  kind: 'scalar',
  resolve: resolveYamlMerge
});

const Type$3 = type;

// [ 64, 65, 66 ] -> [ padding, CR, LF ]
const BASE64_MAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r';

function resolveYamlBinary (data) {
  if (data === null) return false

  let bitlen = 0;
  const max = data.length;
  const map = BASE64_MAP;

  // Convert one by one.
  for (let idx = 0; idx < max; idx++) {
    const code = map.indexOf(data.charAt(idx));

    // Skip CR/LF
    if (code > 64) continue

    // Fail on illegal characters
    if (code < 0) return false

    bitlen += 6;
  }

  // If there are any bits left, source was corrupted
  return (bitlen % 8) === 0
}

function constructYamlBinary (data) {
  const input = data.replace(/[\r\n=]/g, ''); // remove CR/LF & padding to simplify scan
  const max = input.length;
  const map = BASE64_MAP;
  let bits = 0;
  const result = [];

  // Collect by 6*4 bits (3 bytes)

  for (let idx = 0; idx < max; idx++) {
    if ((idx % 4 === 0) && idx) {
      result.push((bits >> 16) & 0xFF);
      result.push((bits >> 8) & 0xFF);
      result.push(bits & 0xFF);
    }

    bits = (bits << 6) | map.indexOf(input.charAt(idx));
  }

  // Dump tail

  const tailbits = (max % 4) * 6;

  if (tailbits === 0) {
    result.push((bits >> 16) & 0xFF);
    result.push((bits >> 8) & 0xFF);
    result.push(bits & 0xFF);
  } else if (tailbits === 18) {
    result.push((bits >> 10) & 0xFF);
    result.push((bits >> 2) & 0xFF);
  } else if (tailbits === 12) {
    result.push((bits >> 4) & 0xFF);
  }

  return new Uint8Array(result)
}

function representYamlBinary (object /*, style */) {
  let result = '';
  let bits = 0;
  const max = object.length;
  const map = BASE64_MAP;

  // Convert every three bytes to 4 ASCII characters.

  for (let idx = 0; idx < max; idx++) {
    if ((idx % 3 === 0) && idx) {
      result += map[(bits >> 18) & 0x3F];
      result += map[(bits >> 12) & 0x3F];
      result += map[(bits >> 6) & 0x3F];
      result += map[bits & 0x3F];
    }

    bits = (bits << 8) + object[idx];
  }

  // Dump tail

  const tail = max % 3;

  if (tail === 0) {
    result += map[(bits >> 18) & 0x3F];
    result += map[(bits >> 12) & 0x3F];
    result += map[(bits >> 6) & 0x3F];
    result += map[bits & 0x3F];
  } else if (tail === 2) {
    result += map[(bits >> 10) & 0x3F];
    result += map[(bits >> 4) & 0x3F];
    result += map[(bits << 2) & 0x3F];
    result += map[64];
  } else if (tail === 1) {
    result += map[(bits >> 2) & 0x3F];
    result += map[(bits << 4) & 0x3F];
    result += map[64];
    result += map[64];
  }

  return result
}

function isBinary (obj) {
  return Object.prototype.toString.call(obj) === '[object Uint8Array]'
}

var binary = new Type$3('tag:yaml.org,2002:binary', {
  kind: 'scalar',
  resolve: resolveYamlBinary,
  construct: constructYamlBinary,
  predicate: isBinary,
  represent: representYamlBinary
});

const Type$2 = type;

const _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
const _toString$2 = Object.prototype.toString;

function resolveYamlOmap (data) {
  if (data === null) return true

  const objectKeys = [];
  const object = data;

  for (let index = 0, length = object.length; index < length; index += 1) {
    const pair = object[index];
    let pairHasKey = false;

    if (_toString$2.call(pair) !== '[object Object]') return false

    let pairKey;
    for (pairKey in pair) {
      if (_hasOwnProperty$3.call(pair, pairKey)) {
        if (!pairHasKey) pairHasKey = true;
        else return false
      }
    }

    if (!pairHasKey) return false

    if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
    else return false
  }

  return true
}

function constructYamlOmap (data) {
  return data !== null ? data : []
}

var omap = new Type$2('tag:yaml.org,2002:omap', {
  kind: 'sequence',
  resolve: resolveYamlOmap,
  construct: constructYamlOmap
});

const Type$1 = type;

const _toString$1 = Object.prototype.toString;

function resolveYamlPairs (data) {
  if (data === null) return true

  const object = data;

  const result = new Array(object.length);

  for (let index = 0, length = object.length; index < length; index += 1) {
    const pair = object[index];

    if (_toString$1.call(pair) !== '[object Object]') return false

    const keys = Object.keys(pair);

    if (keys.length !== 1) return false

    result[index] = [keys[0], pair[keys[0]]];
  }

  return true
}

function constructYamlPairs (data) {
  if (data === null) return []

  const object = data;
  const result = new Array(object.length);

  for (let index = 0, length = object.length; index < length; index += 1) {
    const pair = object[index];

    const keys = Object.keys(pair);

    result[index] = [keys[0], pair[keys[0]]];
  }

  return result
}

var pairs = new Type$1('tag:yaml.org,2002:pairs', {
  kind: 'sequence',
  resolve: resolveYamlPairs,
  construct: constructYamlPairs
});

const Type = type;

const _hasOwnProperty$2 = Object.prototype.hasOwnProperty;

function resolveYamlSet (data) {
  if (data === null) return true

  const object = data;

  for (const key in object) {
    if (_hasOwnProperty$2.call(object, key)) {
      if (object[key] !== null) return false
    }
  }

  return true
}

function constructYamlSet (data) {
  return data !== null ? data : {}
}

var set = new Type('tag:yaml.org,2002:set', {
  kind: 'mapping',
  resolve: resolveYamlSet,
  construct: constructYamlSet
});

var _default = core.extend({
  implicit: [
    timestamp,
    merge
  ],
  explicit: [
    binary,
    omap,
    pairs,
    set
  ]
});

const common$1 = common$5;
const YAMLException$1 = exception;
const makeSnippet = snippet;
const DEFAULT_SCHEMA$1 = _default;

const _hasOwnProperty$1 = Object.prototype.hasOwnProperty;

const CONTEXT_FLOW_IN = 1;
const CONTEXT_FLOW_OUT = 2;
const CONTEXT_BLOCK_IN = 3;
const CONTEXT_BLOCK_OUT = 4;

const CHOMPING_CLIP = 1;
const CHOMPING_STRIP = 2;
const CHOMPING_KEEP = 3;

// eslint-disable-next-line no-control-regex
const PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
const PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
// eslint-disable-next-line no-useless-escape
const PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
// eslint-disable-next-line no-useless-escape
const PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
// eslint-disable-next-line no-useless-escape
const PATTERN_TAG_URI = /^(?:!|[^,\[\]{}])(?:%[0-9a-f]{2}|[0-9a-z\-#;/?:@&=+$,_.!~*'()\[\]])*$/i;

function _class (obj) { return Object.prototype.toString.call(obj) }

function isEol (c) {
  return (c === 0x0A/* LF */) || (c === 0x0D/* CR */)
}

function isWhiteSpace (c) {
  return (c === 0x09/* Tab */) || (c === 0x20/* Space */)
}

function isWsOrEol (c) {
  return (c === 0x09/* Tab */) ||
         (c === 0x20/* Space */) ||
         (c === 0x0A/* LF */) ||
         (c === 0x0D/* CR */)
}

function isFlowIndicator (c) {
  return c === 0x2C/* , */ ||
         c === 0x5B/* [ */ ||
         c === 0x5D/* ] */ ||
         c === 0x7B/* { */ ||
         c === 0x7D/* } */
}

function fromHexCode (c) {
  if ((c >= 0x30/* 0 */) && (c <= 0x39/* 9 */)) {
    return c - 0x30
  }

  const lc = c | 0x20;

  if ((lc >= 0x61/* a */) && (lc <= 0x66/* f */)) {
    return lc - 0x61 + 10
  }

  return -1
}

function escapedHexLen (c) {
  if (c === 0x78/* x */) { return 2 }
  if (c === 0x75/* u */) { return 4 }
  if (c === 0x55/* U */) { return 8 }
  return 0
}

function fromDecimalCode (c) {
  if ((c >= 0x30/* 0 */) && (c <= 0x39/* 9 */)) {
    return c - 0x30
  }

  return -1
}

function simpleEscapeSequence (c) {
  switch (c) {
    case 0x30/* 0 */: return '\x00'
    case 0x61/* a */: return '\x07'
    case 0x62/* b */: return '\x08'
    case 0x74/* t */: return '\x09'
    case 0x09/* Tab */: return '\x09'
    case 0x6E/* n */: return '\x0A'
    case 0x76/* v */: return '\x0B'
    case 0x66/* f */: return '\x0C'
    case 0x72/* r */: return '\x0D'
    case 0x65/* e */: return '\x1B'
    case 0x20/* Space */: return ' '
    case 0x22/* " */: return '\x22'
    case 0x2F/* / */: return '/'
    case 0x5C/* \ */: return '\x5C'
    case 0x4E/* N */: return '\x85'
    case 0x5F/* _ */: return '\xA0'
    case 0x4C/* L */: return '\u2028'
    case 0x50/* P */: return '\u2029'
    default: return ''
  }
}

function charFromCodepoint (c) {
  if (c <= 0xFFFF) {
    return String.fromCharCode(c)
  }
  // Encode UTF-16 surrogate pair
  // https://en.wikipedia.org/wiki/UTF-16#Code_points_U.2B010000_to_U.2B10FFFF
  return String.fromCharCode(
    ((c - 0x010000) >> 10) + 0xD800,
    ((c - 0x010000) & 0x03FF) + 0xDC00
  )
}

// set a property of a literal object, while protecting against prototype pollution,
// see https://github.com/nodeca/js-yaml/issues/164 for more details
function setProperty (object, key, value) {
  // used for this specific key only because Object.defineProperty is slow
  if (key === '__proto__') {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: value
    });
  } else {
    object[key] = value;
  }
}

const simpleEscapeCheck = new Array(256); // integer, for fast access
const simpleEscapeMap = new Array(256);
for (let i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}

function State$1 (input, options) {
  this.input = input;

  this.filename = options['filename'] || null;
  this.schema = options['schema'] || DEFAULT_SCHEMA$1;
  this.onWarning = options['onWarning'] || null;
  // (Hidden) Remove? makes the loader to expect YAML 1.1 documents
  // if such documents have no explicit %YAML directive
  this.legacy = options['legacy'] || false;

  this.json = options['json'] || false;
  this.listener = options['listener'] || null;
  this.maxDepth = typeof options['maxDepth'] === 'number' ? options['maxDepth'] : 100;
  this.maxTotalMergeKeys = typeof options['maxTotalMergeKeys'] === 'number' ? options['maxTotalMergeKeys'] : 10000;

  this.implicitTypes = this.schema.compiledImplicit;
  this.typeMap = this.schema.compiledTypeMap;

  this.length = input.length;
  this.position = 0;
  this.line = 0;
  this.lineStart = 0;
  this.lineIndent = 0;
  this.depth = 0;
  this.totalMergeKeys = 0;

  // position of first leading tab in the current line,
  // used to make sure there are no tabs in the indentation
  this.firstTabInLine = -1;

  this.documents = [];
  this.anchorMapTransactions = [];

  /*
  this.version;
  this.checkLineBreaks;
  this.tagMap;
  this.anchorMap;
  this.tag;
  this.anchor;
  this.kind;
  this.result; */
}

function generateError (state, message) {
  const mark = {
    name: state.filename,
    buffer: state.input.slice(0, -1), // omit trailing \0
    position: state.position,
    line: state.line,
    column: state.position - state.lineStart
  };

  mark.snippet = makeSnippet(mark);

  return new YAMLException$1(message, mark)
}

function throwError (state, message) {
  throw generateError(state, message)
}

function throwWarning (state, message) {
  if (state.onWarning) {
    state.onWarning.call(null, generateError(state, message));
  }
}

function storeAnchor (state, name, value) {
  const transactions = state.anchorMapTransactions;

  if (transactions.length !== 0) {
    const transaction = transactions[transactions.length - 1];

    if (!_hasOwnProperty$1.call(transaction, name)) {
      transaction[name] = {
        existed: _hasOwnProperty$1.call(state.anchorMap, name),
        value: state.anchorMap[name]
      };
    }
  }

  state.anchorMap[name] = value;
}

function beginAnchorTransaction (state) {
  state.anchorMapTransactions.push(Object.create(null));
}

function commitAnchorTransaction (state) {
  const transaction = state.anchorMapTransactions.pop();
  const transactions = state.anchorMapTransactions;

  if (transactions.length === 0) return

  const parent = transactions[transactions.length - 1];
  const names = Object.keys(transaction);

  for (let index = 0, length = names.length; index < length; index += 1) {
    const name = names[index];

    if (!_hasOwnProperty$1.call(parent, name)) {
      parent[name] = transaction[name];
    }
  }
}

function rollbackAnchorTransaction (state) {
  const transaction = state.anchorMapTransactions.pop();
  const names = Object.keys(transaction);

  for (let index = names.length - 1; index >= 0; index -= 1) {
    const entry = transaction[names[index]];

    if (entry.existed) {
      state.anchorMap[names[index]] = entry.value;
    } else {
      delete state.anchorMap[names[index]];
    }
  }
}

function snapshotState (state) {
  return {
    position: state.position,
    line: state.line,
    lineStart: state.lineStart,
    lineIndent: state.lineIndent,
    firstTabInLine: state.firstTabInLine,
    tag: state.tag,
    anchor: state.anchor,
    kind: state.kind,
    result: state.result
  }
}

function restoreState (state, snapshot) {
  state.position = snapshot.position;
  state.line = snapshot.line;
  state.lineStart = snapshot.lineStart;
  state.lineIndent = snapshot.lineIndent;
  state.firstTabInLine = snapshot.firstTabInLine;
  state.tag = snapshot.tag;
  state.anchor = snapshot.anchor;
  state.kind = snapshot.kind;
  state.result = snapshot.result;
}

const directiveHandlers = {

  YAML: function handleYamlDirective (state, name, args) {
    if (state.version !== null) {
      throwError(state, 'duplication of %YAML directive');
    }

    if (args.length !== 1) {
      throwError(state, 'YAML directive accepts exactly one argument');
    }

    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);

    if (match === null) {
      throwError(state, 'ill-formed argument of the YAML directive');
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);

    if (major !== 1) {
      throwError(state, 'unacceptable YAML version of the document');
    }

    state.version = args[0];
    state.checkLineBreaks = (minor < 2);

    if (minor !== 1 && minor !== 2) {
      throwWarning(state, 'unsupported YAML version of the document');
    }
  },

  TAG: function handleTagDirective (state, name, args) {
    let prefix;

    if (args.length !== 2) {
      throwError(state, 'TAG directive accepts exactly two arguments');
    }

    const handle = args[0];
    prefix = args[1];

    if (!PATTERN_TAG_HANDLE.test(handle)) {
      throwError(state, 'ill-formed tag handle (first argument) of the TAG directive');
    }

    if (_hasOwnProperty$1.call(state.tagMap, handle)) {
      throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
    }

    if (!PATTERN_TAG_URI.test(prefix)) {
      throwError(state, 'ill-formed tag prefix (second argument) of the TAG directive');
    }

    try {
      prefix = decodeURIComponent(prefix);
    } catch (err) {
      throwError(state, 'tag prefix is malformed: ' + prefix);
    }

    state.tagMap[handle] = prefix;
  }
};

function captureSegment (state, start, end, checkJson) {
  if (start < end) {
    const _result = state.input.slice(start, end);

    if (checkJson) {
      for (let _position = 0, _length = _result.length; _position < _length; _position += 1) {
        const _character = _result.charCodeAt(_position);
        if (!(_character === 0x09 ||
              (_character >= 0x20 && _character <= 0x10FFFF))) {
          throwError(state, 'expected valid JSON character');
        }
      }
    } else if (PATTERN_NON_PRINTABLE.test(_result)) {
      throwError(state, 'the stream contains non-printable characters');
    }

    state.result += _result;
  }
}

function mergeMappings (state, destination, source, overridableKeys) {
  if (!common$1.isObject(source)) {
    throwError(state, 'cannot merge mappings; the provided source object is unacceptable');
  }

  const sourceKeys = Object.keys(source);

  for (let index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
    const key = sourceKeys[index];

    if (state.maxTotalMergeKeys !== -1 && ++state.totalMergeKeys > state.maxTotalMergeKeys) {
      throwError(state, 'merge keys exceeded maxTotalMergeKeys (' + state.maxTotalMergeKeys + ')');
    }

    if (!_hasOwnProperty$1.call(destination, key)) {
      setProperty(destination, key, source[key]);
      overridableKeys[key] = true;
    }
  }
}

function storeMappingPair (state, _result, overridableKeys, keyTag, keyNode, valueNode,
  startLine, startLineStart, startPos) {
  // The output is a plain object here, so keys can only be strings.
  // We need to convert keyNode to a string, but doing so can hang the process
  // (deeply nested arrays that explode exponentially using aliases).
  if (Array.isArray(keyNode)) {
    keyNode = Array.prototype.slice.call(keyNode);

    for (let index = 0, quantity = keyNode.length; index < quantity; index += 1) {
      if (Array.isArray(keyNode[index])) {
        throwError(state, 'nested arrays are not supported inside keys');
      }

      if (typeof keyNode === 'object' && _class(keyNode[index]) === '[object Object]') {
        keyNode[index] = '[object Object]';
      }
    }
  }

  // Avoid code execution in load() via toString property
  // (still use its own toString for arrays, timestamps,
  // and whatever user schema extensions happen to have @@toStringTag)
  if (typeof keyNode === 'object' && _class(keyNode) === '[object Object]') {
    keyNode = '[object Object]';
  }

  keyNode = String(keyNode);

  if (_result === null) {
    _result = {};
  }

  if (keyTag === 'tag:yaml.org,2002:merge') {
    if (Array.isArray(valueNode)) {
      for (let index = 0, quantity = valueNode.length; index < quantity; index += 1) {
        mergeMappings(state, _result, valueNode[index], overridableKeys);
      }
    } else {
      mergeMappings(state, _result, valueNode, overridableKeys);
    }
  } else {
    if (!state.json &&
        !_hasOwnProperty$1.call(overridableKeys, keyNode) &&
        _hasOwnProperty$1.call(_result, keyNode)) {
      state.line = startLine || state.line;
      state.lineStart = startLineStart || state.lineStart;
      state.position = startPos || state.position;
      throwError(state, 'duplicated mapping key');
    }

    setProperty(_result, keyNode, valueNode);
    delete overridableKeys[keyNode];
  }

  return _result
}

function readLineBreak (state) {
  const ch = state.input.charCodeAt(state.position);

  if (ch === 0x0A/* LF */) {
    state.position++;
  } else if (ch === 0x0D/* CR */) {
    state.position++;
    if (state.input.charCodeAt(state.position) === 0x0A/* LF */) {
      state.position++;
    }
  } else {
    throwError(state, 'a line break is expected');
  }

  state.line += 1;
  state.lineStart = state.position;
  state.firstTabInLine = -1;
}

function skipSeparationSpace (state, allowComments, checkIndent) {
  let lineBreaks = 0;
  let ch = state.input.charCodeAt(state.position);

  while (ch !== 0) {
    while (isWhiteSpace(ch)) {
      if (ch === 0x09/* Tab */ && state.firstTabInLine === -1) {
        state.firstTabInLine = state.position;
      }
      ch = state.input.charCodeAt(++state.position);
    }

    if (allowComments && ch === 0x23/* # */) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (ch !== 0x0A/* LF */ && ch !== 0x0D/* CR */ && ch !== 0)
    }

    if (isEol(ch)) {
      readLineBreak(state);

      ch = state.input.charCodeAt(state.position);
      lineBreaks++;
      state.lineIndent = 0;

      while (ch === 0x20/* Space */) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
    } else {
      break
    }
  }

  if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
    throwWarning(state, 'deficient indentation');
  }

  return lineBreaks
}

function testDocumentSeparator (state) {
  let _position = state.position;
  let ch = state.input.charCodeAt(_position);

  // Condition state.position === state.lineStart is tested
  // in parent on each call, for efficiency. No needs to test here again.
  if ((ch === 0x2D/* - */ || ch === 0x2E/* . */) &&
      ch === state.input.charCodeAt(_position + 1) &&
      ch === state.input.charCodeAt(_position + 2)) {
    _position += 3;

    ch = state.input.charCodeAt(_position);

    if (ch === 0 || isWsOrEol(ch)) {
      return true
    }
  }

  return false
}

function writeFoldedLines (state, count) {
  if (count === 1) {
    state.result += ' ';
  } else if (count > 1) {
    state.result += common$1.repeat('\n', count - 1);
  }
}

function readPlainScalar (state, nodeIndent, withinFlowCollection) {
  let captureStart;
  let captureEnd;
  let hasPendingContent;
  let _line;
  let _lineStart;
  let _lineIndent;
  const _kind = state.kind;
  const _result = state.result;

  let ch = state.input.charCodeAt(state.position);

  if (isWsOrEol(ch) ||
      isFlowIndicator(ch) ||
      ch === 0x23/* # */ ||
      ch === 0x26/* & */ ||
      ch === 0x2A/* * */ ||
      ch === 0x21/* ! */ ||
      ch === 0x7C/* | */ ||
      ch === 0x3E/* > */ ||
      ch === 0x27/* ' */ ||
      ch === 0x22/* " */ ||
      ch === 0x25/* % */ ||
      ch === 0x40/* @ */ ||
      ch === 0x60/* ` */) {
    return false
  }

  if (ch === 0x3F/* ? */ || ch === 0x2D/* - */) {
    const following = state.input.charCodeAt(state.position + 1);

    if (isWsOrEol(following) ||
        (withinFlowCollection && isFlowIndicator(following))) {
      return false
    }
  }

  state.kind = 'scalar';
  state.result = '';
  captureStart = captureEnd = state.position;
  hasPendingContent = false;

  while (ch !== 0) {
    if (ch === 0x3A/* : */) {
      const following = state.input.charCodeAt(state.position + 1);

      if (isWsOrEol(following) ||
          (withinFlowCollection && isFlowIndicator(following))) {
        break
      }
    } else if (ch === 0x23/* # */) {
      const preceding = state.input.charCodeAt(state.position - 1);

      if (isWsOrEol(preceding)) {
        break
      }
    } else if ((state.position === state.lineStart && testDocumentSeparator(state)) ||
               (withinFlowCollection && isFlowIndicator(ch))) {
      break
    } else if (isEol(ch)) {
      _line = state.line;
      _lineStart = state.lineStart;
      _lineIndent = state.lineIndent;
      skipSeparationSpace(state, false, -1);

      if (state.lineIndent >= nodeIndent) {
        hasPendingContent = true;
        ch = state.input.charCodeAt(state.position);
        continue
      } else {
        state.position = captureEnd;
        state.line = _line;
        state.lineStart = _lineStart;
        state.lineIndent = _lineIndent;
        break
      }
    }

    if (hasPendingContent) {
      captureSegment(state, captureStart, captureEnd, false);
      writeFoldedLines(state, state.line - _line);
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
    }

    if (!isWhiteSpace(ch)) {
      captureEnd = state.position + 1;
    }

    ch = state.input.charCodeAt(++state.position);
  }

  captureSegment(state, captureStart, captureEnd, false);

  if (state.result) {
    return true
  }

  state.kind = _kind;
  state.result = _result;
  return false
}

function readSingleQuotedScalar (state, nodeIndent) {
  let captureStart;
  let captureEnd;

  let ch = state.input.charCodeAt(state.position);

  if (ch !== 0x27/* ' */) {
    return false
  }

  state.kind = 'scalar';
  state.result = '';
  state.position++;
  captureStart = captureEnd = state.position;

  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 0x27/* ' */) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);

      if (ch === 0x27/* ' */) {
        captureStart = state.position;
        state.position++;
        captureEnd = state.position;
      } else {
        return true
      }
    } else if (isEol(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, 'unexpected end of the document within a single quoted scalar');
    } else {
      state.position++;
      if (!isWhiteSpace(ch)) {
        captureEnd = state.position;
      }
    }
  }

  throwError(state, 'unexpected end of the stream within a single quoted scalar');
}

function readDoubleQuotedScalar (state, nodeIndent) {
  let captureStart;
  let captureEnd;
  let tmp;

  let ch = state.input.charCodeAt(state.position);

  if (ch !== 0x22/* " */) {
    return false
  }

  state.kind = 'scalar';
  state.result = '';
  state.position++;
  captureStart = captureEnd = state.position;

  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 0x22/* " */) {
      captureSegment(state, captureStart, state.position, true);
      state.position++;
      return true
    } else if (ch === 0x5C/* \ */) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);

      if (isEol(ch)) {
        skipSeparationSpace(state, false, nodeIndent);

        // TODO: rework to inline fn with no type cast?
      } else if (ch < 256 && simpleEscapeCheck[ch]) {
        state.result += simpleEscapeMap[ch];
        state.position++;
      } else if ((tmp = escapedHexLen(ch)) > 0) {
        let hexLength = tmp;
        let hexResult = 0;

        for (; hexLength > 0; hexLength--) {
          ch = state.input.charCodeAt(++state.position);

          if ((tmp = fromHexCode(ch)) >= 0) {
            hexResult = (hexResult << 4) + tmp;
          } else {
            throwError(state, 'expected hexadecimal character');
          }
        }

        state.result += charFromCodepoint(hexResult);

        state.position++;
      } else {
        throwError(state, 'unknown escape sequence');
      }

      captureStart = captureEnd = state.position;
    } else if (isEol(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, 'unexpected end of the document within a double quoted scalar');
    } else {
      state.position++;
      if (!isWhiteSpace(ch)) {
        captureEnd = state.position;
      }
    }
  }

  throwError(state, 'unexpected end of the stream within a double quoted scalar');
}

function readFlowCollection (state, nodeIndent) {
  let readNext = true;
  let _line;
  let _lineStart;
  let _pos;
  const _tag = state.tag;
  let _result;
  const _anchor = state.anchor;
  let terminator;
  let isPair;
  let isExplicitPair;
  let isMapping;
  const overridableKeys = Object.create(null);
  let keyNode;
  let keyTag;
  let valueNode;

  let ch = state.input.charCodeAt(state.position);

  if (ch === 0x5B/* [ */) {
    terminator = 0x5D;/* ] */
    isMapping = false;
    _result = [];
  } else if (ch === 0x7B/* { */) {
    terminator = 0x7D;/* } */
    isMapping = true;
    _result = {};
  } else {
    return false
  }

  if (state.anchor !== null) {
    storeAnchor(state, state.anchor, _result);
  }

  ch = state.input.charCodeAt(++state.position);

  while (ch !== 0) {
    skipSeparationSpace(state, true, nodeIndent);

    ch = state.input.charCodeAt(state.position);

    if (ch === terminator) {
      state.position++;
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = isMapping ? 'mapping' : 'sequence';
      state.result = _result;
      return true
    } else if (!readNext) {
      throwError(state, 'missed comma between flow collection entries');
    } else if (ch === 0x2C/* , */) {
      // "flow collection entries can never be completely empty", as per YAML 1.2, section 7.4
      throwError(state, "expected the node content, but found ','");
    }

    keyTag = keyNode = valueNode = null;
    isPair = isExplicitPair = false;

    if (ch === 0x3F/* ? */) {
      const following = state.input.charCodeAt(state.position + 1);

      if (isWsOrEol(following)) {
        isPair = isExplicitPair = true;
        state.position++;
        skipSeparationSpace(state, true, nodeIndent);
      }
    }

    _line = state.line; // Save the current line.
    _lineStart = state.lineStart;
    _pos = state.position;
    composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    keyTag = state.tag;
    keyNode = state.result;
    skipSeparationSpace(state, true, nodeIndent);

    ch = state.input.charCodeAt(state.position);

    if ((isExplicitPair || state.line === _line) && ch === 0x3A/* : */) {
      isPair = true;
      ch = state.input.charCodeAt(++state.position);
      skipSeparationSpace(state, true, nodeIndent);
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      valueNode = state.result;
    }

    if (isMapping) {
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
    } else if (isPair) {
      _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
    } else {
      _result.push(keyNode);
    }

    skipSeparationSpace(state, true, nodeIndent);

    ch = state.input.charCodeAt(state.position);

    if (ch === 0x2C/* , */) {
      readNext = true;
      ch = state.input.charCodeAt(++state.position);
    } else {
      readNext = false;
    }
  }

  throwError(state, 'unexpected end of the stream within a flow collection');
}

function readBlockScalar (state, nodeIndent) {
  let folding;
  let chomping = CHOMPING_CLIP;
  let didReadContent = false;
  let detectedIndent = false;
  let textIndent = nodeIndent;
  let emptyLines = 0;
  let atMoreIndented = false;
  let tmp;

  let ch = state.input.charCodeAt(state.position);

  if (ch === 0x7C/* | */) {
    folding = false;
  } else if (ch === 0x3E/* > */) {
    folding = true;
  } else {
    return false
  }

  state.kind = 'scalar';
  state.result = '';

  while (ch !== 0) {
    ch = state.input.charCodeAt(++state.position);

    if (ch === 0x2B/* + */ || ch === 0x2D/* - */) {
      if (CHOMPING_CLIP === chomping) {
        chomping = (ch === 0x2B/* + */) ? CHOMPING_KEEP : CHOMPING_STRIP;
      } else {
        throwError(state, 'repeat of a chomping mode identifier');
      }
    } else if ((tmp = fromDecimalCode(ch)) >= 0) {
      if (tmp === 0) {
        throwError(state, 'bad explicit indentation width of a block scalar; it cannot be less than one');
      } else if (!detectedIndent) {
        textIndent = nodeIndent + tmp - 1;
        detectedIndent = true;
      } else {
        throwError(state, 'repeat of an indentation width identifier');
      }
    } else {
      break
    }
  }

  if (isWhiteSpace(ch)) {
    do { ch = state.input.charCodeAt(++state.position); }
    while (isWhiteSpace(ch))

    if (ch === 0x23/* # */) {
      do { ch = state.input.charCodeAt(++state.position); }
      while (!isEol(ch) && (ch !== 0))
    }
  }

  while (ch !== 0) {
    readLineBreak(state);
    state.lineIndent = 0;

    ch = state.input.charCodeAt(state.position);

    // eslint-disable-next-line no-unmodified-loop-condition
    while ((!detectedIndent || state.lineIndent < textIndent) &&
           (ch === 0x20/* Space */)) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }

    if (!detectedIndent && state.lineIndent > textIndent) {
      textIndent = state.lineIndent;
    }

    if (isEol(ch)) {
      emptyLines++;
      continue
    }

    if (!detectedIndent && textIndent === 0) {
      throwError(state, 'missing indentation for block scalar');
    }

    // End of the scalar.
    if (state.lineIndent < textIndent) {
      // Perform the chomping.
      if (chomping === CHOMPING_KEEP) {
        state.result += common$1.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);
      } else if (chomping === CHOMPING_CLIP) {
        if (didReadContent) { // i.e. only if the scalar is not empty.
          state.result += '\n';
        }
      }

      // Break this `while` cycle and go to the funciton's epilogue.
      break
    }

    // Folded style: use fancy rules to handle line breaks.
    if (folding) {
      // Lines starting with white space characters (more-indented lines) are not folded.
      if (isWhiteSpace(ch)) {
        atMoreIndented = true;
        // except for the first content line (cf. Example 8.1)
        state.result += common$1.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);

      // End of more-indented block.
      } else if (atMoreIndented) {
        atMoreIndented = false;
        state.result += common$1.repeat('\n', emptyLines + 1);

      // Just one line break - perceive as the same line.
      } else if (emptyLines === 0) {
        if (didReadContent) { // i.e. only if we have already read some scalar content.
          state.result += ' ';
        }

      // Several line breaks - perceive as different lines.
      } else {
        state.result += common$1.repeat('\n', emptyLines);
      }

    // Literal style: just add exact number of line breaks between content lines.
    } else {
      // Keep all line breaks except the header line break.
      state.result += common$1.repeat('\n', didReadContent ? 1 + emptyLines : emptyLines);
    }

    didReadContent = true;
    detectedIndent = true;
    emptyLines = 0;
    const captureStart = state.position;

    while (!isEol(ch) && (ch !== 0)) {
      ch = state.input.charCodeAt(++state.position);
    }

    captureSegment(state, captureStart, state.position, false);
  }

  return true
}

function readBlockSequence (state, nodeIndent) {
  const _tag = state.tag;
  const _anchor = state.anchor;
  const _result = [];
  let detected = false;

  // there is a leading tab before this token, so it can't be a block sequence/mapping;
  // it can still be flow sequence/mapping or a scalar
  if (state.firstTabInLine !== -1) return false

  if (state.anchor !== null) {
    storeAnchor(state, state.anchor, _result);
  }

  let ch = state.input.charCodeAt(state.position);

  while (ch !== 0) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, 'tab characters must not be used in indentation');
    }

    if (ch !== 0x2D/* - */) {
      break
    }

    const following = state.input.charCodeAt(state.position + 1);

    if (!isWsOrEol(following)) {
      break
    }

    detected = true;
    state.position++;

    if (skipSeparationSpace(state, true, -1)) {
      if (state.lineIndent <= nodeIndent) {
        _result.push(null);
        ch = state.input.charCodeAt(state.position);
        continue
      }
    }

    const _line = state.line;
    composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    _result.push(state.result);
    skipSeparationSpace(state, true, -1);

    ch = state.input.charCodeAt(state.position);

    if ((state.line === _line || state.lineIndent > nodeIndent) && (ch !== 0)) {
      throwError(state, 'bad indentation of a sequence entry');
    } else if (state.lineIndent < nodeIndent) {
      break
    }
  }

  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = 'sequence';
    state.result = _result;
    return true
  }
  return false
}

function readBlockMapping (state, nodeIndent, flowIndent) {
  let allowCompact;
  let _keyLine;
  let _keyLineStart;
  let _keyPos;
  const _tag = state.tag;
  const _anchor = state.anchor;
  const _result = {};
  const overridableKeys = Object.create(null);
  let keyTag = null;
  let keyNode = null;
  let valueNode = null;
  let atExplicitKey = false;
  let detected = false;

  // there is a leading tab before this token, so it can't be a block sequence/mapping;
  // it can still be flow sequence/mapping or a scalar
  if (state.firstTabInLine !== -1) return false

  if (state.anchor !== null) {
    storeAnchor(state, state.anchor, _result);
  }

  let ch = state.input.charCodeAt(state.position);

  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, 'tab characters must not be used in indentation');
    }

    const following = state.input.charCodeAt(state.position + 1);
    const _line = state.line; // Save the current line.

    //
    // Explicit notation case. There are two separate blocks:
    // first for the key (denoted by "?") and second for the value (denoted by ":")
    //
    if ((ch === 0x3F/* ? */ || ch === 0x3A/* : */) && isWsOrEol(following)) {
      if (ch === 0x3F/* ? */) {
        if (atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }

        detected = true;
        atExplicitKey = true;
        allowCompact = true;
      } else if (atExplicitKey) {
        // i.e. 0x3A/* : */ === character after the explicit key.
        atExplicitKey = false;
        allowCompact = true;
      } else {
        throwError(state, 'incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line');
      }

      state.position += 1;
      ch = following;

    //
    // Implicit notation case. Flow-style node as the key first, then ":", and the value.
    //
    } else {
      _keyLine = state.line;
      _keyLineStart = state.lineStart;
      _keyPos = state.position;

      if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
        // Neither implicit nor explicit notation.
        // Reading is done. Go to the epilogue.
        break
      }

      if (state.line === _line) {
        ch = state.input.charCodeAt(state.position);

        while (isWhiteSpace(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }

        if (ch === 0x3A/* : */) {
          ch = state.input.charCodeAt(++state.position);

          if (!isWsOrEol(ch)) {
            throwError(state, 'a whitespace character is expected after the key-value separator within a block mapping');
          }

          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }

          detected = true;
          atExplicitKey = false;
          allowCompact = false;
          keyTag = state.tag;
          keyNode = state.result;
        } else if (detected) {
          throwError(state, 'can not read an implicit mapping pair; a colon is missed');
        } else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true // Keep the result of `composeNode`.
        }
      } else if (detected) {
        throwError(state, 'can not read a block mapping entry; a multiline key may not be an implicit key');
      } else {
        state.tag = _tag;
        state.anchor = _anchor;
        return true // Keep the result of `composeNode`.
      }
    }

    //
    // Common reading code for both explicit and implicit notations.
    //
    if (state.line === _line || state.lineIndent > nodeIndent) {
      if (atExplicitKey) {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
      }

      if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
        if (atExplicitKey) {
          keyNode = state.result;
        } else {
          valueNode = state.result;
        }
      }

      if (!atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
        keyTag = keyNode = valueNode = null;
      }

      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
    }

    if ((state.line === _line || state.lineIndent > nodeIndent) && (ch !== 0)) {
      throwError(state, 'bad indentation of a mapping entry');
    } else if (state.lineIndent < nodeIndent) {
      break
    }
  }

  //
  // Epilogue.
  //

  // Special case: last mapping's node contains only the key in explicit notation.
  if (atExplicitKey) {
    storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
  }

  // Expose the resulting mapping.
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = 'mapping';
    state.result = _result;
  }

  return detected
}

function readTagProperty (state) {
  let isVerbatim = false;
  let isNamed = false;
  let tagHandle;
  let tagName;

  let ch = state.input.charCodeAt(state.position);

  if (ch !== 0x21/* ! */) return false

  if (state.tag !== null) {
    throwError(state, 'duplication of a tag property');
  }

  ch = state.input.charCodeAt(++state.position);

  if (ch === 0x3C/* < */) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 0x21/* ! */) {
    isNamed = true;
    tagHandle = '!!';
    ch = state.input.charCodeAt(++state.position);
  } else {
    tagHandle = '!';
  }

  let _position = state.position;

  if (isVerbatim) {
    do { ch = state.input.charCodeAt(++state.position); }
    while (ch !== 0 && ch !== 0x3E/* > */)

    if (state.position < state.length) {
      tagName = state.input.slice(_position, state.position);
      ch = state.input.charCodeAt(++state.position);
    } else {
      throwError(state, 'unexpected end of the stream within a verbatim tag');
    }
  } else {
    while (ch !== 0 && !isWsOrEol(ch)) {
      if (ch === 0x21/* ! */) {
        if (!isNamed) {
          tagHandle = state.input.slice(_position - 1, state.position + 1);

          if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
            throwError(state, 'named tag handle cannot contain such characters');
          }

          isNamed = true;
          _position = state.position + 1;
        } else {
          throwError(state, 'tag suffix cannot contain exclamation marks');
        }
      }

      ch = state.input.charCodeAt(++state.position);
    }

    tagName = state.input.slice(_position, state.position);

    if (PATTERN_FLOW_INDICATORS.test(tagName)) {
      throwError(state, 'tag suffix cannot contain flow indicator characters');
    }
  }

  if (tagName && !PATTERN_TAG_URI.test(tagName)) {
    throwError(state, 'tag name cannot contain such characters: ' + tagName);
  }

  try {
    tagName = decodeURIComponent(tagName);
  } catch (err) {
    throwError(state, 'tag name is malformed: ' + tagName);
  }

  if (isVerbatim) {
    state.tag = tagName;
  } else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) {
    state.tag = state.tagMap[tagHandle] + tagName;
  } else if (tagHandle === '!') {
    state.tag = '!' + tagName;
  } else if (tagHandle === '!!') {
    state.tag = 'tag:yaml.org,2002:' + tagName;
  } else {
    throwError(state, 'undeclared tag handle "' + tagHandle + '"');
  }

  return true
}

function readAnchorProperty (state) {
  let ch = state.input.charCodeAt(state.position);

  if (ch !== 0x26/* & */) return false

  if (state.anchor !== null) {
    throwError(state, 'duplication of an anchor property');
  }

  ch = state.input.charCodeAt(++state.position);
  const _position = state.position;

  while (ch !== 0 && !isWsOrEol(ch) && !isFlowIndicator(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }

  if (state.position === _position) {
    throwError(state, 'name of an anchor node must contain at least one character');
  }

  state.anchor = state.input.slice(_position, state.position);
  return true
}

function readAlias (state) {
  let ch = state.input.charCodeAt(state.position);

  if (ch !== 0x2A/* * */) return false

  ch = state.input.charCodeAt(++state.position);
  const _position = state.position;

  while (ch !== 0 && !isWsOrEol(ch) && !isFlowIndicator(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }

  if (state.position === _position) {
    throwError(state, 'name of an alias node must contain at least one character');
  }

  const alias = state.input.slice(_position, state.position);

  if (!_hasOwnProperty$1.call(state.anchorMap, alias)) {
    throwError(state, 'unidentified alias "' + alias + '"');
  }

  state.result = state.anchorMap[alias];
  skipSeparationSpace(state, true, -1);
  return true
}

function tryReadBlockMappingFromProperty (state, propertyStart, nodeIndent, flowIndent) {
  const fallbackState = snapshotState(state);

  beginAnchorTransaction(state);
  restoreState(state, propertyStart);

  // Re-read the leading properties as part of the first implicit key, not as
  // properties of the current node.
  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;

  if (readBlockMapping(state, nodeIndent, flowIndent) && state.kind === 'mapping') {
    commitAnchorTransaction(state);
    return true
  }

  rollbackAnchorTransaction(state);
  restoreState(state, fallbackState);
  return false
}

function composeNode (state, parentIndent, nodeContext, allowToSeek, allowCompact) {
  let allowBlockScalars;
  let allowBlockCollections;
  let indentStatus = 1; // 1: this>parent, 0: this=parent, -1: this<parent
  let atNewLine = false;
  let hasContent = false;
  let propertyStart = null;
  let type;
  let flowIndent;
  let blockIndent;

  if (state.depth >= state.maxDepth) {
    throwError(state, 'nesting exceeded maxDepth (' + state.maxDepth + ')');
  }

  state.depth += 1;

  if (state.listener !== null) {
    state.listener('open', state);
  }

  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;

  const allowBlockStyles = allowBlockScalars = allowBlockCollections =
    CONTEXT_BLOCK_OUT === nodeContext ||
    CONTEXT_BLOCK_IN === nodeContext;

  if (allowToSeek) {
    if (skipSeparationSpace(state, true, -1)) {
      atNewLine = true;

      if (state.lineIndent > parentIndent) {
        indentStatus = 1;
      } else if (state.lineIndent === parentIndent) {
        indentStatus = 0;
      } else if (state.lineIndent < parentIndent) {
        indentStatus = -1;
      }
    }
  }

  if (indentStatus === 1) {
    while (true) {
      const ch = state.input.charCodeAt(state.position);
      const propertyState = snapshotState(state);

      // A duplicate property token after a line break can be the first key of
      // a nested block mapping, e.g. `!!map\n  !!str key: value`.
      if (atNewLine &&
          ((ch === 0x21/* ! */ && state.tag !== null) ||
           (ch === 0x26/* & */ && state.anchor !== null))) {
        break
      }

      if (!readTagProperty(state) && !readAnchorProperty(state)) {
        break
      }

      if (propertyStart === null) {
        propertyStart = propertyState;
      }

      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        allowBlockCollections = allowBlockStyles;

        if (state.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      } else {
        allowBlockCollections = false;
      }
    }
  }

  if (allowBlockCollections) {
    allowBlockCollections = atNewLine || allowCompact;
  }

  if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
    if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
      flowIndent = parentIndent;
    } else {
      flowIndent = parentIndent + 1;
    }

    blockIndent = state.position - state.lineStart;

    if (indentStatus === 1) {
      if ((allowBlockCollections &&
          (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent))) ||
          readFlowCollection(state, flowIndent)) {
        hasContent = true;
      } else {
        const ch = state.input.charCodeAt(state.position);

        if (propertyStart !== null && allowBlockStyles && !allowBlockCollections &&
            ch !== 0x7C/* | */ && ch !== 0x3E/* > */ &&
            tryReadBlockMappingFromProperty(
              state,
              propertyStart,
              propertyStart.position - propertyStart.lineStart,
              flowIndent
            )) {
          hasContent = true;
        } else if ((allowBlockScalars && readBlockScalar(state, flowIndent)) ||
            readSingleQuotedScalar(state, flowIndent) ||
            readDoubleQuotedScalar(state, flowIndent)) {
          hasContent = true;
        } else if (readAlias(state)) {
          hasContent = true;

          if (state.tag !== null || state.anchor !== null) {
            throwError(state, 'alias node should not have any properties');
          }
        } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
          hasContent = true;

          if (state.tag === null) {
            state.tag = '?';
          }
        }

        if (state.anchor !== null) {
          storeAnchor(state, state.anchor, state.result);
        }
      }
    } else if (indentStatus === 0) {
      // Special case: block sequences are allowed to have same indentation level as the parent.
      // http://www.yaml.org/spec/1.2/spec.html#id2799784
      hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
    }
  }

  if (state.tag === null) {
    if (state.anchor !== null) {
      storeAnchor(state, state.anchor, state.result);
    }
  } else if (state.tag === '?') {
    // Implicit resolving is not allowed for non-scalar types, and '?'
    // non-specific tag is only automatically assigned to plain scalars.
    //
    // We only need to check kind conformity in case user explicitly assigns '?'
    // tag, for example like this: "!<?> [0]"
    //
    if (state.result !== null && state.kind !== 'scalar') {
      throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
    }

    for (let typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
      type = state.implicitTypes[typeIndex];

      if (type.resolve(state.result)) { // `state.result` updated in resolver if matched
        state.result = type.construct(state.result);
        state.tag = type.tag;
        if (state.anchor !== null) {
          storeAnchor(state, state.anchor, state.result);
        }
        break
      }
    }
  } else if (state.tag !== '!') {
    if (_hasOwnProperty$1.call(state.typeMap[state.kind || 'fallback'], state.tag)) {
      type = state.typeMap[state.kind || 'fallback'][state.tag];
    } else {
      // looking for multi type
      type = null;
      const typeList = state.typeMap.multi[state.kind || 'fallback'];

      for (let typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
        if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
          type = typeList[typeIndex];
          break
        }
      }
    }

    if (!type) {
      throwError(state, 'unknown tag !<' + state.tag + '>');
    }

    if (state.result !== null && type.kind !== state.kind) {
      throwError(state, 'unacceptable node kind for !<' + state.tag + '> tag; it should be "' + type.kind + '", not "' + state.kind + '"');
    }

    if (!type.resolve(state.result, state.tag)) { // `state.result` updated in resolver if matched
      throwError(state, 'cannot resolve a node with !<' + state.tag + '> explicit tag');
    } else {
      state.result = type.construct(state.result, state.tag);
      if (state.anchor !== null) {
        storeAnchor(state, state.anchor, state.result);
      }
    }
  }

  if (state.listener !== null) {
    state.listener('close', state);
  }

  state.depth -= 1;
  return state.tag !== null || state.anchor !== null || hasContent
}

function readDocument (state) {
  const documentStart = state.position;
  let hasDirectives = false;
  let ch;

  state.version = null;
  state.checkLineBreaks = state.legacy;
  state.tagMap = Object.create(null);
  state.anchorMap = Object.create(null);

  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    skipSeparationSpace(state, true, -1);

    ch = state.input.charCodeAt(state.position);

    if (state.lineIndent > 0 || ch !== 0x25/* % */) {
      break
    }

    hasDirectives = true;
    ch = state.input.charCodeAt(++state.position);
    let _position = state.position;

    while (ch !== 0 && !isWsOrEol(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }

    const directiveName = state.input.slice(_position, state.position);
    const directiveArgs = [];

    if (directiveName.length < 1) {
      throwError(state, 'directive name must not be less than one character in length');
    }

    while (ch !== 0) {
      while (isWhiteSpace(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }

      if (ch === 0x23/* # */) {
        do { ch = state.input.charCodeAt(++state.position); }
        while (ch !== 0 && !isEol(ch))
        break
      }

      if (isEol(ch)) break

      _position = state.position;

      while (ch !== 0 && !isWsOrEol(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }

      directiveArgs.push(state.input.slice(_position, state.position));
    }

    if (ch !== 0) readLineBreak(state);

    if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
      directiveHandlers[directiveName](state, directiveName, directiveArgs);
    } else {
      throwWarning(state, 'unknown document directive "' + directiveName + '"');
    }
  }

  skipSeparationSpace(state, true, -1);

  if (state.lineIndent === 0 &&
      state.input.charCodeAt(state.position) === 0x2D/* - */ &&
      state.input.charCodeAt(state.position + 1) === 0x2D/* - */ &&
      state.input.charCodeAt(state.position + 2) === 0x2D/* - */) {
    state.position += 3;
    skipSeparationSpace(state, true, -1);
  } else if (hasDirectives) {
    throwError(state, 'directives end mark is expected');
  }

  composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
  skipSeparationSpace(state, true, -1);

  if (state.checkLineBreaks &&
      PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
    throwWarning(state, 'non-ASCII line breaks are interpreted as content');
  }

  state.documents.push(state.result);

  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    if (state.input.charCodeAt(state.position) === 0x2E/* . */) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    }
    return
  }

  if (state.position < (state.length - 1)) {
    throwError(state, 'end of the stream or a document separator is expected');
  }
}

function loadDocuments (input, options) {
  input = String(input);
  options = options || {};

  if (input.length !== 0) {
    // Add tailing `\n` if not exists
    if (input.charCodeAt(input.length - 1) !== 0x0A/* LF */ &&
        input.charCodeAt(input.length - 1) !== 0x0D/* CR */) {
      input += '\n';
    }

    // Strip BOM
    if (input.charCodeAt(0) === 0xFEFF) {
      input = input.slice(1);
    }
  }

  const state = new State$1(input, options);

  const nullpos = input.indexOf('\0');

  if (nullpos !== -1) {
    state.position = nullpos;
    throwError(state, 'null byte is not allowed in input');
  }

  // Use 0 as string terminator. That significantly simplifies bounds check.
  state.input += '\0';

  while (state.input.charCodeAt(state.position) === 0x20/* Space */) {
    state.lineIndent += 1;
    state.position += 1;
  }

  while (state.position < (state.length - 1)) {
    readDocument(state);
  }

  return state.documents
}

function loadAll (input, iterator, options) {
  if (iterator !== null && typeof iterator === 'object' && typeof options === 'undefined') {
    options = iterator;
    iterator = null;
  }

  const documents = loadDocuments(input, options);

  if (typeof iterator !== 'function') {
    return documents
  }

  for (let index = 0, length = documents.length; index < length; index += 1) {
    iterator(documents[index]);
  }
}

function load (input, options) {
  const documents = loadDocuments(input, options);

  if (documents.length === 0) {
    return undefined
  } else if (documents.length === 1) {
    return documents[0]
  }
  throw new YAMLException$1('expected a single document in the stream, but found more')
}

loader$1.loadAll = loadAll;
loader$1.load = load;

var dumper$1 = {};

const common = common$5;
const YAMLException = exception;
const DEFAULT_SCHEMA = _default;

const _toString = Object.prototype.toString;
const _hasOwnProperty = Object.prototype.hasOwnProperty;

const CHAR_BOM = 0xFEFF;
const CHAR_TAB = 0x09; /* Tab */
const CHAR_LINE_FEED = 0x0A; /* LF */
const CHAR_CARRIAGE_RETURN = 0x0D; /* CR */
const CHAR_SPACE = 0x20; /* Space */
const CHAR_EXCLAMATION = 0x21; /* ! */
const CHAR_DOUBLE_QUOTE = 0x22; /* " */
const CHAR_SHARP = 0x23; /* # */
const CHAR_PERCENT = 0x25; /* % */
const CHAR_AMPERSAND = 0x26; /* & */
const CHAR_SINGLE_QUOTE = 0x27; /* ' */
const CHAR_ASTERISK = 0x2A; /* * */
const CHAR_COMMA = 0x2C; /* , */
const CHAR_MINUS = 0x2D; /* - */
const CHAR_COLON = 0x3A; /* : */
const CHAR_EQUALS = 0x3D; /* = */
const CHAR_GREATER_THAN = 0x3E; /* > */
const CHAR_QUESTION = 0x3F; /* ? */
const CHAR_COMMERCIAL_AT = 0x40; /* @ */
const CHAR_LEFT_SQUARE_BRACKET = 0x5B; /* [ */
const CHAR_RIGHT_SQUARE_BRACKET = 0x5D; /* ] */
const CHAR_GRAVE_ACCENT = 0x60; /* ` */
const CHAR_LEFT_CURLY_BRACKET = 0x7B; /* { */
const CHAR_VERTICAL_LINE = 0x7C; /* | */
const CHAR_RIGHT_CURLY_BRACKET = 0x7D; /* } */

const ESCAPE_SEQUENCES = {};

ESCAPE_SEQUENCES[0x00] = '\\0';
ESCAPE_SEQUENCES[0x07] = '\\a';
ESCAPE_SEQUENCES[0x08] = '\\b';
ESCAPE_SEQUENCES[0x09] = '\\t';
ESCAPE_SEQUENCES[0x0A] = '\\n';
ESCAPE_SEQUENCES[0x0B] = '\\v';
ESCAPE_SEQUENCES[0x0C] = '\\f';
ESCAPE_SEQUENCES[0x0D] = '\\r';
ESCAPE_SEQUENCES[0x1B] = '\\e';
ESCAPE_SEQUENCES[0x22] = '\\"';
ESCAPE_SEQUENCES[0x5C] = '\\\\';
ESCAPE_SEQUENCES[0x85] = '\\N';
ESCAPE_SEQUENCES[0xA0] = '\\_';
ESCAPE_SEQUENCES[0x2028] = '\\L';
ESCAPE_SEQUENCES[0x2029] = '\\P';

const DEPRECATED_BOOLEANS_SYNTAX = [
  'y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON',
  'n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF'
];

const DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;

function compileStyleMap (schema, map) {
  if (map === null) return {}

  const result = {};
  const keys = Object.keys(map);

  for (let index = 0, length = keys.length; index < length; index += 1) {
    let tag = keys[index];
    let style = String(map[tag]);

    if (tag.slice(0, 2) === '!!') {
      tag = 'tag:yaml.org,2002:' + tag.slice(2);
    }
    const type = schema.compiledTypeMap['fallback'][tag];

    if (type && _hasOwnProperty.call(type.styleAliases, style)) {
      style = type.styleAliases[style];
    }

    result[tag] = style;
  }

  return result
}

function encodeHex (character) {
  let handle;
  let length;

  const string = character.toString(16).toUpperCase();

  if (character <= 0xFF) {
    handle = 'x';
    length = 2;
  } else if (character <= 0xFFFF) {
    handle = 'u';
    length = 4;
  } else if (character <= 0xFFFFFFFF) {
    handle = 'U';
    length = 8;
  } else {
    throw new YAMLException('code point within a string may not be greater than 0xFFFFFFFF')
  }

  return '\\' + handle + common.repeat('0', length - string.length) + string
}

const QUOTING_TYPE_SINGLE = 1;
const QUOTING_TYPE_DOUBLE = 2;

function State (options) {
  this.schema = options['schema'] || DEFAULT_SCHEMA;
  this.indent = Math.max(1, (options['indent'] || 2));
  this.noArrayIndent = options['noArrayIndent'] || false;
  this.skipInvalid = options['skipInvalid'] || false;
  this.flowLevel = (common.isNothing(options['flowLevel']) ? -1 : options['flowLevel']);
  this.styleMap = compileStyleMap(this.schema, options['styles'] || null);
  this.sortKeys = options['sortKeys'] || false;
  this.lineWidth = options['lineWidth'] || 80;
  this.noRefs = options['noRefs'] || false;
  this.noCompatMode = options['noCompatMode'] || false;
  this.condenseFlow = options['condenseFlow'] || false;
  this.quotingType = options['quotingType'] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
  this.forceQuotes = options['forceQuotes'] || false;
  this.replacer = typeof options['replacer'] === 'function' ? options['replacer'] : null;

  this.implicitTypes = this.schema.compiledImplicit;
  this.explicitTypes = this.schema.compiledExplicit;

  this.tag = null;
  this.result = '';

  this.duplicates = [];
  this.usedDuplicates = null;
}

// Indents every line in a string. Empty lines (\n only) are not indented.
function indentString (string, spaces) {
  const ind = common.repeat(' ', spaces);
  let position = 0;
  let result = '';
  const length = string.length;

  while (position < length) {
    let line;
    const next = string.indexOf('\n', position);
    if (next === -1) {
      line = string.slice(position);
      position = length;
    } else {
      line = string.slice(position, next + 1);
      position = next + 1;
    }

    if (line.length && line !== '\n') result += ind;

    result += line;
  }

  return result
}

function generateNextLine (state, level) {
  return '\n' + common.repeat(' ', state.indent * level)
}

function testImplicitResolving (state, str) {
  for (let index = 0, length = state.implicitTypes.length; index < length; index += 1) {
    const type = state.implicitTypes[index];

    if (type.resolve(str)) {
      return true
    }
  }

  return false
}

// [33] s-white ::= s-space | s-tab
function isWhitespace (c) {
  return c === CHAR_SPACE || c === CHAR_TAB
}

// Returns true if the character can be printed without escaping.
// From YAML 1.2: "any allowed characters known to be non-printable
// should also be escaped. [However,] This isn’t mandatory"
// Derived from nb-char - \t - #x85 - #xA0 - #x2028 - #x2029.
function isPrintable (c) {
  return (c >= 0x00020 && c <= 0x00007E) ||
    ((c >= 0x000A1 && c <= 0x00D7FF) && c !== 0x2028 && c !== 0x2029) ||
    ((c >= 0x0E000 && c <= 0x00FFFD) && c !== CHAR_BOM) ||
    (c >= 0x10000 && c <= 0x10FFFF)
}

// [34] ns-char ::= nb-char - s-white
// [27] nb-char ::= c-printable - b-char - c-byte-order-mark
// [26] b-char  ::= b-line-feed | b-carriage-return
// Including s-white (for some reason, examples doesn't match specs in this aspect)
// ns-char ::= c-printable - b-line-feed - b-carriage-return - c-byte-order-mark
function isNsCharOrWhitespace (c) {
  return isPrintable(c) &&
    c !== CHAR_BOM &&
    // - b-char
    c !== CHAR_CARRIAGE_RETURN &&
    c !== CHAR_LINE_FEED
}

// [127]  ns-plain-safe(c) ::= c = flow-out  ⇒ ns-plain-safe-out
//                             c = flow-in   ⇒ ns-plain-safe-in
//                             c = block-key ⇒ ns-plain-safe-out
//                             c = flow-key  ⇒ ns-plain-safe-in
// [128] ns-plain-safe-out ::= ns-char
// [129]  ns-plain-safe-in ::= ns-char - c-flow-indicator
// [130]  ns-plain-char(c) ::=  ( ns-plain-safe(c) - “:” - “#” )
//                            | ( /* An ns-char preceding */ “#” )
//                            | ( “:” /* Followed by an ns-plain-safe(c) */ )
function isPlainSafe (c, prev, inblock) {
  const cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
  const cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
  return (
    (
      // ns-plain-safe
      inblock // c = flow-in
        ? cIsNsCharOrWhitespace
        : cIsNsCharOrWhitespace &&
          // - c-flow-indicator
          c !== CHAR_COMMA &&
          c !== CHAR_LEFT_SQUARE_BRACKET &&
          c !== CHAR_RIGHT_SQUARE_BRACKET &&
          c !== CHAR_LEFT_CURLY_BRACKET &&
          c !== CHAR_RIGHT_CURLY_BRACKET
    ) &&
    // ns-plain-char
    c !== CHAR_SHARP && // false on '#'
    !(prev === CHAR_COLON && !cIsNsChar)
  ) || // false on ': '
  (isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP) || // change to true on '[^ ]#'
  (prev === CHAR_COLON && cIsNsChar) // change to true on ':[^ ]'
}

// Simplified test for values allowed as the first character in plain style.
function isPlainSafeFirst (c) {
  // Uses a subset of ns-char - c-indicator
  // where ns-char = nb-char - s-white.
  // No support of ( ( “?” | “:” | “-” ) /* Followed by an ns-plain-safe(c)) */ ) part
  return isPrintable(c) &&
    c !== CHAR_BOM &&
    !isWhitespace(c) && // - s-white
    // - (c-indicator ::=
    // “-” | “?” | “:” | “,” | “[” | “]” | “{” | “}”
    c !== CHAR_MINUS &&
    c !== CHAR_QUESTION &&
    c !== CHAR_COLON &&
    c !== CHAR_COMMA &&
    c !== CHAR_LEFT_SQUARE_BRACKET &&
    c !== CHAR_RIGHT_SQUARE_BRACKET &&
    c !== CHAR_LEFT_CURLY_BRACKET &&
    c !== CHAR_RIGHT_CURLY_BRACKET &&
    // | “#” | “&” | “*” | “!” | “|” | “=” | “>” | “'” | “"”
    c !== CHAR_SHARP &&
    c !== CHAR_AMPERSAND &&
    c !== CHAR_ASTERISK &&
    c !== CHAR_EXCLAMATION &&
    c !== CHAR_VERTICAL_LINE &&
    c !== CHAR_EQUALS &&
    c !== CHAR_GREATER_THAN &&
    c !== CHAR_SINGLE_QUOTE &&
    c !== CHAR_DOUBLE_QUOTE &&
    // | “%” | “@” | “`”)
    c !== CHAR_PERCENT &&
    c !== CHAR_COMMERCIAL_AT &&
    c !== CHAR_GRAVE_ACCENT
}

// Simplified test for values allowed as the last character in plain style.
function isPlainSafeLast (c) {
  // just not whitespace or colon, it will be checked to be plain character later
  return !isWhitespace(c) && c !== CHAR_COLON
}

// Same as 'string'.codePointAt(pos), but works in older browsers.
function codePointAt (string, pos) {
  const first = string.charCodeAt(pos);
  let second;

  if (first >= 0xD800 && first <= 0xDBFF && pos + 1 < string.length) {
    second = string.charCodeAt(pos + 1);
    if (second >= 0xDC00 && second <= 0xDFFF) {
      // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
      return (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000
    }
  }
  return first
}

// Determines whether block indentation indicator is required.
function needIndentIndicator (string) {
  const leadingSpaceRe = /^\n* /;
  return leadingSpaceRe.test(string)
}

const STYLE_PLAIN = 1;
const STYLE_SINGLE = 2;
const STYLE_LITERAL = 3;
const STYLE_FOLDED = 4;
const STYLE_DOUBLE = 5;

// Determines which scalar styles are possible and returns the preferred style.
// lineWidth = -1 => no limit.
// Pre-conditions: str.length > 0.
// Post-conditions:
//    STYLE_PLAIN or STYLE_SINGLE => no \n are in the string.
//    STYLE_LITERAL => no lines are suitable for folding (or lineWidth is -1).
//    STYLE_FOLDED => a line > lineWidth and can be folded (and lineWidth != -1).
function chooseScalarStyle (string, singleLineOnly, indentPerLevel, lineWidth,
  testAmbiguousType, quotingType, forceQuotes, inblock) {
  let i;
  let char = 0;
  let prevChar = null;
  let hasLineBreak = false;
  let hasFoldableLine = false; // only checked if shouldTrackWidth
  const shouldTrackWidth = lineWidth !== -1;
  let previousLineBreak = -1; // count the first line correctly
  let plain = isPlainSafeFirst(codePointAt(string, 0)) &&
    isPlainSafeLast(codePointAt(string, string.length - 1));

  if (singleLineOnly || forceQuotes) {
    // Case: no block styles.
    // Check for disallowed characters to rule out plain and single.
    for (i = 0; i < string.length; char >= 0x10000 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (!isPrintable(char)) {
        return STYLE_DOUBLE
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
  } else {
    // Case: block styles permitted.
    for (i = 0; i < string.length; char >= 0x10000 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (char === CHAR_LINE_FEED) {
        hasLineBreak = true;
        // Check if any line can be folded.
        if (shouldTrackWidth) {
          hasFoldableLine = hasFoldableLine ||
            // Foldable line = too long, and not more-indented.
            (i - previousLineBreak - 1 > lineWidth &&
             string[previousLineBreak + 1] !== ' ');
          previousLineBreak = i;
        }
      } else if (!isPrintable(char)) {
        return STYLE_DOUBLE
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
    // in case the end is missing a \n
    hasFoldableLine = hasFoldableLine || (shouldTrackWidth &&
      (i - previousLineBreak - 1 > lineWidth &&
       string[previousLineBreak + 1] !== ' '));
  }
  // Although every style can represent \n without escaping, prefer block styles
  // for multiline, since they're more readable and they don't add empty lines.
  // Also prefer folding a super-long line.
  if (!hasLineBreak && !hasFoldableLine) {
    // Strings interpretable as another type have to be quoted;
    // e.g. the string 'true' vs. the boolean true.
    if (plain && !forceQuotes && !testAmbiguousType(string)) {
      return STYLE_PLAIN
    }
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE
  }
  // Edge case: block indentation indicator can only have one digit.
  if (indentPerLevel > 9 && needIndentIndicator(string)) {
    return STYLE_DOUBLE
  }
  // At this point we know block styles are valid.
  // Prefer literal style unless we want to fold.
  if (!forceQuotes) {
    return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL
  }
  return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE
}

// Note: line breaking/folding is implemented for only the folded style.
// NB. We drop the last trailing newline (if any) of a returned block scalar
//  since the dumper adds its own newline. This always works:
//    • No ending newline => unaffected; already using strip "-" chomping.
//    • Ending newline    => removed then restored.
//  Importantly, this keeps the "+" chomp indicator from gaining an extra line.
function writeScalar (state, string, level, iskey, inblock) {
  state.dump = (function () {
    if (string.length === 0) {
      return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''"
    }
    if (!state.noCompatMode) {
      if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
        return state.quotingType === QUOTING_TYPE_DOUBLE ? ('"' + string + '"') : ("'" + string + "'")
      }
    }

    const indent = state.indent * Math.max(1, level); // no 0-indent scalars
    // As indentation gets deeper, let the width decrease monotonically
    // to the lower bound min(state.lineWidth, 40).
    // Note that this implies
    //  state.lineWidth ≤ 40 + state.indent: width is fixed at the lower bound.
    //  state.lineWidth > 40 + state.indent: width decreases until the lower bound.
    // This behaves better than a constant minimum width which disallows narrower options,
    // or an indent threshold which causes the width to suddenly increase.
    const lineWidth = (state.lineWidth === -1)
      ? -1
      : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);

    // Without knowing if keys are implicit/explicit, assume implicit for safety.
    const singleLineOnly = iskey ||
      // No block styles in flow mode.
      (state.flowLevel > -1 && level >= state.flowLevel);
    function testAmbiguity (string) {
      return testImplicitResolving(state, string)
    }

    switch (chooseScalarStyle(string, singleLineOnly, state.indent, lineWidth,
      testAmbiguity, state.quotingType, state.forceQuotes && !iskey, inblock)) {
      case STYLE_PLAIN:
        return string
      case STYLE_SINGLE:
        return "'" + string.replace(/'/g, "''") + "'"
      case STYLE_LITERAL:
        return '|' + blockHeader(string, state.indent) +
          dropEndingNewline(indentString(string, indent))
      case STYLE_FOLDED:
        return '>' + blockHeader(string, state.indent) +
          dropEndingNewline(indentString(foldString(string, lineWidth), indent))
      case STYLE_DOUBLE:
        return '"' + escapeString(string) + '"'
      default:
        throw new YAMLException('impossible error: invalid scalar style')
    }
  }());
}

// Pre-conditions: string is valid for a block scalar, 1 <= indentPerLevel <= 9.
function blockHeader (string, indentPerLevel) {
  const indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : '';

  // note the special case: the string '\n' counts as a "trailing" empty line.
  const clip = string[string.length - 1] === '\n';
  const keep = clip && (string[string.length - 2] === '\n' || string === '\n');
  const chomp = keep ? '+' : (clip ? '' : '-');

  return indentIndicator + chomp + '\n'
}

// (See the note for writeScalar.)
function dropEndingNewline (string) {
  return string[string.length - 1] === '\n' ? string.slice(0, -1) : string
}

// Note: a long line without a suitable break point will exceed the width limit.
// Pre-conditions: every char in str isPrintable, str.length > 0, width > 0.
function foldString (string, width) {
  // In folded style, $k$ consecutive newlines output as $k+1$ newlines—
  // unless they're before or after a more-indented line, or at the very
  // beginning or end, in which case $k$ maps to $k$.
  // Therefore, parse each chunk as newline(s) followed by a content line.
  const lineRe = /(\n+)([^\n]*)/g;

  // first line (possibly an empty line)
  let result = (function () {
    let nextLF = string.indexOf('\n');
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width)
  }());
  // If we haven't reached the first content line yet, don't add an extra \n.
  let prevMoreIndented = string[0] === '\n' || string[0] === ' ';
  let moreIndented;

  // rest of the lines
  let match;
  while ((match = lineRe.exec(string))) {
    const prefix = match[1];
    const line = match[2];

    moreIndented = (line[0] === ' ');
    result += prefix +
      ((!prevMoreIndented && !moreIndented && line !== '') ? '\n' : '') +
      foldLine(line, width);
    prevMoreIndented = moreIndented;
  }

  return result
}

// Greedy line breaking.
// Picks the longest line under the limit each time,
// otherwise settles for the shortest line over the limit.
// NB. More-indented lines *cannot* be folded, as that would add an extra \n.
function foldLine (line, width) {
  if (line === '' || line[0] === ' ') return line

  // Since a more-indented line adds a \n, breaks can't be followed by a space.
  const breakRe = / [^ ]/g; // note: the match index will always be <= length-2.
  let match;
  // start is an inclusive index. end, curr, and next are exclusive.
  let start = 0;
  let end;
  let curr = 0;
  let next = 0;
  let result = '';

  // Invariants: 0 <= start <= length-1.
  //   0 <= curr <= next <= max(0, length-2). curr - start <= width.
  // Inside the loop:
  //   A match implies length >= 2, so curr and next are <= length-2.
  while ((match = breakRe.exec(line))) {
    next = match.index;
    // maintain invariant: curr - start <= width
    if (next - start > width) {
      end = (curr > start) ? curr : next; // derive end <= length-2
      result += '\n' + line.slice(start, end);
      // skip the space that was output as \n
      start = end + 1;                    // derive start <= length-1
    }
    curr = next;
  }

  // By the invariants, start <= length-1, so there is something left over.
  // It is either the whole string or a part starting from non-whitespace.
  result += '\n';
  // Insert a break if the remainder is too long and there is a break available.
  if (line.length - start > width && curr > start) {
    result += line.slice(start, curr) + '\n' + line.slice(curr + 1);
  } else {
    result += line.slice(start);
  }

  return result.slice(1) // drop extra \n joiner
}

// Escapes a double-quoted string.
function escapeString (string) {
  let result = '';
  let char = 0;

  for (let i = 0; i < string.length; char >= 0x10000 ? i += 2 : i++) {
    char = codePointAt(string, i);
    const escapeSeq = ESCAPE_SEQUENCES[char];

    if (!escapeSeq && isPrintable(char)) {
      result += string[i];
      if (char >= 0x10000) result += string[i + 1];
    } else {
      result += escapeSeq || encodeHex(char);
    }
  }

  return result
}

function writeFlowSequence (state, level, object) {
  let _result = '';
  const _tag = state.tag;

  for (let index = 0, length = object.length; index < length; index += 1) {
    let value = object[index];

    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }

    // Write only valid elements, put null instead of invalid elements.
    if (writeNode(state, level, value, false, false) ||
        (typeof value === 'undefined' &&
         writeNode(state, level, null, false, false))) {
      if (_result !== '') _result += ',' + (!state.condenseFlow ? ' ' : '');
      _result += state.dump;
    }
  }

  state.tag = _tag;
  state.dump = '[' + _result + ']';
}

function writeBlockSequence (state, level, object, compact) {
  let _result = '';
  const _tag = state.tag;

  for (let index = 0, length = object.length; index < length; index += 1) {
    let value = object[index];

    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }

    // Write only valid elements, put null instead of invalid elements.
    if (writeNode(state, level + 1, value, true, true, false, true) ||
        (typeof value === 'undefined' &&
         writeNode(state, level + 1, null, true, true, false, true))) {
      if (!compact || _result !== '') {
        _result += generateNextLine(state, level);
      }

      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        _result += '-';
      } else {
        _result += '- ';
      }

      _result += state.dump;
    }
  }

  state.tag = _tag;
  state.dump = _result || '[]'; // Empty sequence if no valid values.
}

function writeFlowMapping (state, level, object) {
  let _result = '';
  const _tag = state.tag;
  const objectKeyList = Object.keys(object);

  for (let index = 0, length = objectKeyList.length; index < length; index += 1) {
    let pairBuffer = '';
    if (_result !== '') pairBuffer += ', ';

    if (state.condenseFlow) pairBuffer += '"';

    const objectKey = objectKeyList[index];
    let objectValue = object[objectKey];

    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }

    if (!writeNode(state, level, objectKey, false, false)) {
      continue // Skip this pair because of invalid key;
    }

    if (state.dump.length > 1024) pairBuffer += '? ';

    pairBuffer += state.dump + (state.condenseFlow ? '"' : '') + ':' + (state.condenseFlow ? '' : ' ');

    if (!writeNode(state, level, objectValue, false, false)) {
      continue // Skip this pair because of invalid value.
    }

    pairBuffer += state.dump;

    // Both key and value are valid.
    _result += pairBuffer;
  }

  state.tag = _tag;
  state.dump = '{' + _result + '}';
}

function writeBlockMapping (state, level, object, compact) {
  let _result = '';
  const _tag = state.tag;
  const objectKeyList = Object.keys(object);

  // Allow sorting keys so that the output file is deterministic
  if (state.sortKeys === true) {
    // Default sorting
    objectKeyList.sort();
  } else if (typeof state.sortKeys === 'function') {
    // Custom sort function
    objectKeyList.sort(state.sortKeys);
  } else if (state.sortKeys) {
    // Something is wrong
    throw new YAMLException('sortKeys must be a boolean or a function')
  }

  for (let index = 0, length = objectKeyList.length; index < length; index += 1) {
    let pairBuffer = '';

    if (!compact || _result !== '') {
      pairBuffer += generateNextLine(state, level);
    }

    const objectKey = objectKeyList[index];
    let objectValue = object[objectKey];

    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }

    if (!writeNode(state, level + 1, objectKey, true, true, true)) {
      continue // Skip this pair because of invalid key.
    }

    const explicitPair = (state.tag !== null && state.tag !== '?') ||
                   (state.dump && state.dump.length > 1024);

    if (explicitPair) {
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        pairBuffer += '?';
      } else {
        pairBuffer += '? ';
      }
    }

    pairBuffer += state.dump;

    if (explicitPair) {
      pairBuffer += generateNextLine(state, level);
    }

    if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
      continue // Skip this pair because of invalid value.
    }

    if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
      pairBuffer += ':';
    } else {
      pairBuffer += ': ';
    }

    pairBuffer += state.dump;

    // Both key and value are valid.
    _result += pairBuffer;
  }

  state.tag = _tag;
  state.dump = _result || '{}'; // Empty mapping if no valid pairs.
}

function detectType (state, object, explicit) {
  const typeList = explicit ? state.explicitTypes : state.implicitTypes;

  for (let index = 0, length = typeList.length; index < length; index += 1) {
    const type = typeList[index];

    if ((type.instanceOf || type.predicate) &&
        (!type.instanceOf || ((typeof object === 'object') && (object instanceof type.instanceOf))) &&
        (!type.predicate || type.predicate(object))) {
      if (explicit) {
        if (type.multi && type.representName) {
          state.tag = type.representName(object);
        } else {
          state.tag = type.tag;
        }
      } else {
        state.tag = '?';
      }

      if (type.represent) {
        const style = state.styleMap[type.tag] || type.defaultStyle;

        let _result;
        if (_toString.call(type.represent) === '[object Function]') {
          _result = type.represent(object, style);
        } else if (_hasOwnProperty.call(type.represent, style)) {
          _result = type.represent[style](object, style);
        } else {
          throw new YAMLException('!<' + type.tag + '> tag resolver accepts not "' + style + '" style')
        }

        state.dump = _result;
      }

      return true
    }
  }

  return false
}

// Serializes `object` and writes it to global `result`.
// Returns true on success, or false on invalid object.
//
function writeNode (state, level, object, block, compact, iskey, isblockseq) {
  state.tag = null;
  state.dump = object;

  if (!detectType(state, object, false)) {
    detectType(state, object, true);
  }

  const type = _toString.call(state.dump);
  const inblock = block;

  if (block) {
    block = (state.flowLevel < 0 || state.flowLevel > level);
  }

  const objectOrArray = type === '[object Object]' || type === '[object Array]';
  let duplicateIndex;
  let duplicate;

  if (objectOrArray) {
    duplicateIndex = state.duplicates.indexOf(object);
    duplicate = duplicateIndex !== -1;
  }

  if ((state.tag !== null && state.tag !== '?') || duplicate || (state.indent !== 2 && level > 0)) {
    compact = false;
  }

  if (duplicate && state.usedDuplicates[duplicateIndex]) {
    state.dump = '*ref_' + duplicateIndex;
  } else {
    if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
      state.usedDuplicates[duplicateIndex] = true;
    }
    if (type === '[object Object]') {
      if (block && (Object.keys(state.dump).length !== 0)) {
        writeBlockMapping(state, level, state.dump, compact);
        if (duplicate) {
          state.dump = '&ref_' + duplicateIndex + state.dump;
        }
      } else {
        writeFlowMapping(state, level, state.dump);
        if (duplicate) {
          state.dump = '&ref_' + duplicateIndex + ' ' + state.dump;
        }
      }
    } else if (type === '[object Array]') {
      if (block && (state.dump.length !== 0)) {
        if (state.noArrayIndent && !isblockseq && level > 0) {
          writeBlockSequence(state, level - 1, state.dump, compact);
        } else {
          writeBlockSequence(state, level, state.dump, compact);
        }
        if (duplicate) {
          state.dump = '&ref_' + duplicateIndex + state.dump;
        }
      } else {
        writeFlowSequence(state, level, state.dump);
        if (duplicate) {
          state.dump = '&ref_' + duplicateIndex + ' ' + state.dump;
        }
      }
    } else if (type === '[object String]') {
      if (state.tag !== '?') {
        writeScalar(state, state.dump, level, iskey, inblock);
      }
    } else if (type === '[object Undefined]') {
      return false
    } else {
      if (state.skipInvalid) return false
      throw new YAMLException('unacceptable kind of an object to dump ' + type)
    }

    if (state.tag !== null && state.tag !== '?') {
      // Need to encode all characters except those allowed by the spec:
      //
      // [35] ns-dec-digit    ::=  [#x30-#x39] /* 0-9 */
      // [36] ns-hex-digit    ::=  ns-dec-digit
      //                         | [#x41-#x46] /* A-F */ | [#x61-#x66] /* a-f */
      // [37] ns-ascii-letter ::=  [#x41-#x5A] /* A-Z */ | [#x61-#x7A] /* a-z */
      // [38] ns-word-char    ::=  ns-dec-digit | ns-ascii-letter | “-”
      // [39] ns-uri-char     ::=  “%” ns-hex-digit ns-hex-digit | ns-word-char | “#”
      //                         | “;” | “/” | “?” | “:” | “@” | “&” | “=” | “+” | “$” | “,”
      //                         | “_” | “.” | “!” | “~” | “*” | “'” | “(” | “)” | “[” | “]”
      //
      // Also need to encode '!' because it has special meaning (end of tag prefix).
      //
      let tagStr = encodeURI(
        state.tag[0] === '!' ? state.tag.slice(1) : state.tag
      ).replace(/!/g, '%21');

      if (state.tag[0] === '!') {
        tagStr = '!' + tagStr;
      } else if (tagStr.slice(0, 18) === 'tag:yaml.org,2002:') {
        tagStr = '!!' + tagStr.slice(18);
      } else {
        tagStr = '!<' + tagStr + '>';
      }

      state.dump = tagStr + ' ' + state.dump;
    }
  }

  return true
}

function getDuplicateReferences (object, state) {
  const objects = [];
  const duplicatesIndexes = [];

  inspectNode(object, objects, duplicatesIndexes);

  const length = duplicatesIndexes.length;
  for (let index = 0; index < length; index += 1) {
    state.duplicates.push(objects[duplicatesIndexes[index]]);
  }
  state.usedDuplicates = new Array(length);
}

function inspectNode (object, objects, duplicatesIndexes) {
  if (object !== null && typeof object === 'object') {
    const index = objects.indexOf(object);
    if (index !== -1) {
      if (duplicatesIndexes.indexOf(index) === -1) {
        duplicatesIndexes.push(index);
      }
    } else {
      objects.push(object);

      if (Array.isArray(object)) {
        for (let i = 0, length = object.length; i < length; i += 1) {
          inspectNode(object[i], objects, duplicatesIndexes);
        }
      } else {
        const objectKeyList = Object.keys(object);

        for (let i = 0, length = objectKeyList.length; i < length; i += 1) {
          inspectNode(object[objectKeyList[i]], objects, duplicatesIndexes);
        }
      }
    }
  }
}

function dump (input, options) {
  options = options || {};

  const state = new State(options);

  if (!state.noRefs) getDuplicateReferences(input, state);

  let value = input;

  if (state.replacer) {
    value = state.replacer.call({ '': value }, '', value);
  }

  if (writeNode(state, 0, value, true, true)) return state.dump + '\n'

  return ''
}

dumper$1.dump = dump;

const loader = loader$1;
const dumper = dumper$1;

function renamed (from, to) {
  return function () {
    throw new Error('Function yaml.' + from + ' is removed in js-yaml 4. ' +
      'Use yaml.' + to + ' instead, which is now safe by default.')
  }
}

jsYaml.Type = type;
jsYaml.Schema = schema;
jsYaml.FAILSAFE_SCHEMA = failsafe;
jsYaml.JSON_SCHEMA = json;
jsYaml.CORE_SCHEMA = core;
jsYaml.DEFAULT_SCHEMA = _default;
jsYaml.load = loader.load;
jsYaml.loadAll = loader.loadAll;
jsYaml.dump = dumper.dump;
jsYaml.YAMLException = exception;

// Re-export all types in case user wants to create custom schema
jsYaml.types = {
  binary: binary,
  float: float,
  map: map,
  null: _null,
  pairs: pairs,
  set: set,
  timestamp: timestamp,
  bool: bool,
  int: int,
  merge: merge,
  omap: omap,
  seq: seq,
  str: str
};

// Removed functions from JS-YAML 3.0.x
jsYaml.safeLoad = renamed('safeLoad', 'load');
jsYaml.safeLoadAll = renamed('safeLoadAll', 'loadAll');
jsYaml.safeDump = renamed('safeDump', 'dump');

(function (exports) {
	var __createBinding = (commonjsGlobal && commonjsGlobal.__createBinding) || (Object.create ? (function(o, m, k, k2) {
	    if (k2 === undefined) k2 = k;
	    var desc = Object.getOwnPropertyDescriptor(m, k);
	    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
	      desc = { enumerable: true, get: function() { return m[k]; } };
	    }
	    Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
	    if (k2 === undefined) k2 = k;
	    o[k2] = m[k];
	}));
	var __setModuleDefault = (commonjsGlobal && commonjsGlobal.__setModuleDefault) || (Object.create ? (function(o, v) {
	    Object.defineProperty(o, "default", { enumerable: true, value: v });
	}) : function(o, v) {
	    o["default"] = v;
	});
	var __importStar = (commonjsGlobal && commonjsGlobal.__importStar) || (function () {
	    var ownKeys = function(o) {
	        ownKeys = Object.getOwnPropertyNames || function (o) {
	            var ar = [];
	            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
	            return ar;
	        };
	        return ownKeys(o);
	    };
	    return function (mod) {
	        if (mod && mod.__esModule) return mod;
	        var result = {};
	        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
	        __setModuleDefault(result, mod);
	        return result;
	    };
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.VALIDATION_RULES = void 0;
	exports.loadItemKindsFromSchema = loadItemKindsFromSchema;
	exports.validateCollectionId = validateCollectionId;
	exports.validateVersion = validateVersion;
	exports.validateItemKind = validateItemKind;
	exports.normalizeRepoRelativePath = normalizeRepoRelativePath;
	exports.isSafeRepoRelativePath = isSafeRepoRelativePath;
	exports.validateCollectionObject = validateCollectionObject;
	exports.validateCollectionFile = validateCollectionFile;
	exports.validateAllCollections = validateAllCollections;
	exports.generateMarkdown = generateMarkdown;
	/**
	 * Collection validation utilities.
	 * @module validate
	 *
	 * Shared validation logic for collection files.
	 * Used by validate-collections, build-collection-bundle, and publish-collections
	 * to ensure consistent validation across all components.
	 */
	const fs = __importStar(require$$0);
	const path = __importStar(require$$1);
	const yaml = __importStar(jsYaml);
	/**
	 * Load valid item kinds from the JSON schema (single source of truth).
	 * Falls back to a default list if schema cannot be loaded.
	 * @param schemaDir - Directory containing the schema file
	 * @returns Array of valid item kinds
	 */
	function loadItemKindsFromSchema(schemaDir) {
	    try {
	        const schemaPath = schemaDir
	            ? path.join(schemaDir, 'collection.schema.json')
	            : path.join(__dirname, '..', '..', 'schemas', 'collection.schema.json');
	        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
	        const kinds = schema?.properties?.items?.items?.properties?.kind?.enum;
	        if (Array.isArray(kinds) && kinds.length > 0) {
	            return kinds;
	        }
	    }
	    catch {
	        // Schema unavailable or malformed, use fallback
	    }
	    return ['prompt', 'instruction', 'agent', 'skill'];
	}
	/**
	 * Validation rules for collections.
	 * These rules are shared across all validation components for consistency.
	 * Item kinds are loaded from the JSON schema for single source of truth.
	 */
	exports.VALIDATION_RULES = {
	    collectionId: {
	        maxLength: 100,
	        pattern: /^[a-z0-9-]+$/,
	        description: 'lowercase letters, numbers, and hyphens only'
	    },
	    version: {
	        pattern: /^\d+\.\d+\.\d+$/,
	        default: '1.0.0',
	        description: 'semantic versioning format (X.Y.Z)'
	    },
	    itemKinds: loadItemKindsFromSchema(),
	    deprecatedKinds: {
	        chatmode: 'agent',
	        'chat-mode': 'agent'
	    }
	};
	/**
	 * Validate a collection ID.
	 * @param id - Collection ID to validate
	 * @returns Validation result
	 */
	function validateCollectionId(id) {
	    if (!id || typeof id !== 'string') {
	        return { valid: false, error: 'Collection ID is required and must be a string' };
	    }
	    if (id.length > exports.VALIDATION_RULES.collectionId.maxLength) {
	        return {
	            valid: false,
	            error: `Collection ID must be at most ${exports.VALIDATION_RULES.collectionId.maxLength} characters (got ${id.length})`
	        };
	    }
	    if (!exports.VALIDATION_RULES.collectionId.pattern.test(id)) {
	        return {
	            valid: false,
	            error: `Collection ID must contain only ${exports.VALIDATION_RULES.collectionId.description}`
	        };
	    }
	    return { valid: true };
	}
	/**
	 * Validate a version string.
	 * @param version - Version string to validate
	 * @returns Validation result with normalized version
	 */
	function validateVersion(version) {
	    // If no version provided, use default
	    if (version === undefined || version === null) {
	        return { valid: true, normalized: exports.VALIDATION_RULES.version.default };
	    }
	    if (typeof version !== 'string') {
	        return { valid: false, error: 'Version must be a string' };
	    }
	    if (!exports.VALIDATION_RULES.version.pattern.test(version)) {
	        return {
	            valid: false,
	            error: `Version must follow ${exports.VALIDATION_RULES.version.description} (got "${version}")`
	        };
	    }
	    return { valid: true, normalized: version };
	}
	/**
	 * Validate an item kind.
	 * @param kind - Item kind to validate
	 * @returns Validation result
	 */
	function validateItemKind(kind) {
	    if (!kind || typeof kind !== 'string') {
	        return { valid: false, error: 'Item kind is required and must be a string' };
	    }
	    const normalizedKind = kind.toLowerCase();
	    // Check for deprecated kinds (chatmode)
	    if (exports.VALIDATION_RULES.deprecatedKinds[normalizedKind]) {
	        const replacement = exports.VALIDATION_RULES.deprecatedKinds[normalizedKind];
	        return {
	            valid: false,
	            error: `Item kind '${kind}' is deprecated. Use '${replacement}' instead`,
	            deprecated: true,
	            replacement
	        };
	    }
	    // Check for valid kinds
	    if (!exports.VALIDATION_RULES.itemKinds.includes(normalizedKind)) {
	        return {
	            valid: false,
	            error: `Invalid item kind '${kind}'. Must be one of: ${exports.VALIDATION_RULES.itemKinds.join(', ')}`
	        };
	    }
	    return { valid: true };
	}
	/**
	 * Normalize a path to be repo-root relative.
	 * Uses POSIX normalization since collection paths are repo-root relative
	 * and should work consistently across platforms.
	 * @param p - Path to normalize
	 * @returns Normalized repo-relative path
	 * @throws {Error} if path is empty, traverses outside repo, or is absolute
	 */
	function normalizeRepoRelativePath(p) {
	    if (!p || typeof p !== 'string') {
	        throw new Error('path must be a non-empty string');
	    }
	    const s = String(p).trim().replace(/\\/g, '/').replace(/^\//, '');
	    if (!s) {
	        throw new Error('path must be a non-empty string');
	    }
	    // Use posix normalization since collection paths are repo-root relative.
	    const normalized = path.posix.normalize(s);
	    if (normalized.startsWith('../') || normalized === '..') {
	        throw new Error('path must not traverse outside repo');
	    }
	    if (normalized.startsWith('/')) {
	        throw new Error('path must be repo-root relative');
	    }
	    return normalized;
	}
	/**
	 * Check if a path is a safe repo-relative path.
	 * @param p - Path to check
	 * @returns True if path is valid and safe
	 */
	function isSafeRepoRelativePath(p) {
	    try {
	        normalizeRepoRelativePath(p);
	        return true;
	    }
	    catch {
	        return false;
	    }
	}
	/**
	 * Validate a collection object structure.
	 * @param collection - Parsed collection object
	 * @param sourceLabel - Label for error messages
	 * @returns Validation result
	 */
	function validateCollectionObject(collection, sourceLabel) {
	    const errors = [];
	    if (!collection || typeof collection !== 'object') {
	        return { ok: false, errors: [`${sourceLabel}: YAML did not parse to an object`] };
	    }
	    const col = collection;
	    // Validate collection ID
	    if (!col.id || typeof col.id !== 'string') {
	        errors.push(`${sourceLabel}: Missing required field: id`);
	    }
	    else {
	        const idResult = validateCollectionId(col.id);
	        if (!idResult.valid) {
	            errors.push(`${sourceLabel}: ${idResult.error}`);
	        }
	    }
	    if (!col.name || typeof col.name !== 'string') {
	        errors.push(`${sourceLabel}: Missing required field: name`);
	    }
	    // Validate version if present
	    if (col.version !== undefined) {
	        const versionResult = validateVersion(col.version);
	        if (!versionResult.valid) {
	            errors.push(`${sourceLabel}: ${versionResult.error}`);
	        }
	    }
	    // Validate readme if present (optional field)
	    if (col.readme !== undefined) {
	        if (!col.readme || typeof col.readme !== 'object') {
	            errors.push(`${sourceLabel}: readme must be an object with a "path" property`);
	        }
	        else {
	            const readme = col.readme;
	            if (!readme.path || typeof readme.path !== 'string' || readme.path.trim() === '') {
	                errors.push(`${sourceLabel}: readme.path must be a non-empty string`);
	            }
	            else {
	                try {
	                    normalizeRepoRelativePath(readme.path);
	                }
	                catch {
	                    errors.push(`${sourceLabel}: readme.path has an invalid path (must be repo-root relative): ${readme.path}`);
	                }
	            }
	        }
	    }
	    if (!Array.isArray(col.items)) {
	        errors.push(`${sourceLabel}: Missing required field: items (array)`);
	    }
	    if (Array.isArray(col.items)) {
	        col.items.forEach((item, idx) => {
	            const prefix = `${sourceLabel}: items[${idx}]`;
	            if (!item || typeof item !== 'object') {
	                errors.push(`${prefix}: must be an object`);
	                return;
	            }
	            const it = item;
	            if (!it.path || typeof it.path !== 'string') {
	                errors.push(`${prefix}: Missing required field: path`);
	            }
	            else {
	                try {
	                    normalizeRepoRelativePath(it.path);
	                }
	                catch {
	                    errors.push(`${prefix}: Invalid path (must be repo-root relative): ${it.path}`);
	                }
	            }
	            if (!it.kind || typeof it.kind !== 'string') {
	                errors.push(`${prefix}: Missing required field: kind`);
	            }
	            else {
	                // Validate item kind (including chatmode rejection)
	                const kindResult = validateItemKind(it.kind);
	                if (!kindResult.valid) {
	                    errors.push(`${prefix}: ${kindResult.error}`);
	                }
	            }
	        });
	    }
	    return { ok: errors.length === 0, errors };
	}
	/**
	 * Validate a collection file from disk.
	 * Checks YAML syntax, required fields, and referenced file existence.
	 * @param repoRoot - Repository root path
	 * @param collectionFile - Collection file path (absolute or repo-relative)
	 * @returns Validation result with parsed collection
	 */
	function validateCollectionFile(repoRoot, collectionFile) {
	    const rel = collectionFile.replace(/\\/g, '/');
	    const abs = path.isAbsolute(collectionFile)
	        ? collectionFile
	        : path.join(repoRoot, collectionFile);
	    const errors = [];
	    const warnings = [];
	    if (!fs.existsSync(abs)) {
	        return { ok: false, errors: [`${rel}: Collection file not found`] };
	    }
	    let collection;
	    try {
	        collection = yaml.load(fs.readFileSync(abs, 'utf8'));
	    }
	    catch (e) {
	        const message = e instanceof Error ? e.message : String(e);
	        return { ok: false, errors: [`${rel}: YAML parse error: ${message}`] };
	    }
	    const schema = validateCollectionObject(collection, rel);
	    errors.push(...schema.errors);
	    if (Array.isArray(collection?.items)) {
	        collection.items.forEach((item, idx) => {
	            if (!item?.path || typeof item.path !== 'string') {
	                return;
	            }
	            let relPath;
	            try {
	                relPath = normalizeRepoRelativePath(item.path);
	            }
	            catch {
	                return;
	            }
	            const itemAbs = path.join(repoRoot, relPath);
	            if (!fs.existsSync(itemAbs)) {
	                errors.push(`${rel}: items[${idx}] referenced file not found: ${relPath}`);
	            }
	        });
	    }
	    if (collection?.readme?.path) {
	        let relPath;
	        try {
	            relPath = normalizeRepoRelativePath(collection.readme.path);
	        }
	        catch {
	            return { ok: false, errors: [...errors, `${rel}: readme path is invalid: ${collection.readme.path}`] };
	        }
	        const readmeAbs = path.join(repoRoot, relPath);
	        if (!fs.existsSync(readmeAbs)) {
	            errors.push(`${rel}: readme referenced file not found: ${relPath}`);
	        }
	    }
	    else {
	        warnings.push(`${rel}: Collection has no readme. Consider adding a readme to help users understand this collection.`);
	    }
	    return { ok: errors.length === 0, errors, warnings, collection };
	}
	/**
	 * Validate all collections in a repository, including duplicate detection.
	 * @param repoRoot - Repository root path
	 * @param collectionFiles - Array of collection file paths (repo-relative)
	 * @returns Validation result
	 */
	function validateAllCollections(repoRoot, collectionFiles) {
	    const errors = [];
	    const warnings = [];
	    const fileResults = [];
	    const seenIds = new Map(); // id -> file path
	    const seenNames = new Map(); // name -> file path
	    for (const file of collectionFiles) {
	        const result = validateCollectionFile(repoRoot, file);
	        fileResults.push({ file, ...result });
	        errors.push(...result.errors);
	        if (result.warnings) {
	            warnings.push(...result.warnings);
	        }
	        // Check for duplicate IDs and names
	        if (result.collection) {
	            const { id, name } = result.collection;
	            if (id && seenIds.has(id)) {
	                errors.push(`${file}: Duplicate collection ID '${id}' (also in ${seenIds.get(id)})`);
	            }
	            else if (id) {
	                seenIds.set(id, file);
	            }
	            if (name && seenNames.has(name)) {
	                errors.push(`${file}: Duplicate collection name '${name}' (also in ${seenNames.get(name)})`);
	            }
	            else if (name) {
	                seenNames.set(name, file);
	            }
	        }
	    }
	    return { ok: errors.length === 0, errors, warnings, fileResults };
	}
	/**
	 * Generate markdown content for PR comment from validation result.
	 * @param result - Result from validateAllCollections
	 * @param totalFiles - Total number of collection files
	 * @returns Markdown content
	 */
	function generateMarkdown(result, totalFiles) {
	    let md = '## 📋 Collection Validation Results\n\n';
	    if (result.ok) {
	        md += `✅ **All ${totalFiles} collection(s) validated successfully!**\n`;
	    }
	    else {
	        md += `❌ **Validation failed with ${result.errors.length} error(s)**\n\n`;
	        md += '### Errors\n\n';
	        result.errors.forEach((err) => {
	            md += `- ${err}\n`;
	        });
	    }
	    if (result.warnings && result.warnings.length > 0) {
	        md += '\n### Warnings\n\n';
	        result.warnings.forEach((warn) => {
	            md += `- ⚠️ ${warn}\n`;
	        });
	    }
	    return md;
	}
	
} (validate));

var collections = {};

var __createBinding = (commonjsGlobal && commonjsGlobal.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (commonjsGlobal && commonjsGlobal.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (commonjsGlobal && commonjsGlobal.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(collections, "__esModule", { value: true });
collections.listCollectionFiles = listCollectionFiles;
collections.readCollection = readCollection;
collections.resolveCollectionItemPaths = resolveCollectionItemPaths;
collections.resolveCollectionReadmePath = resolveCollectionReadmePath;
/**
 * Collection file utilities.
 * @module collections
 */
const fs = __importStar(require$$0);
const path = __importStar(require$$1);
const yaml = __importStar(jsYaml);
const validate_1 = validate;
/**
 * List all collection files in the repository.
 * @param repoRoot - Repository root path
 * @returns Array of collection file paths (repo-relative)
 */
function listCollectionFiles(repoRoot) {
    const collectionsDir = path.join(repoRoot, 'collections');
    return fs
        .readdirSync(collectionsDir)
        .filter((f) => f.endsWith('.collection.yml'))
        .map((f) => path.join('collections', f));
}
/**
 * Read and parse a collection YAML file.
 * @param repoRoot - Repository root path
 * @param collectionFile - Collection file path (absolute or repo-relative)
 * @returns Parsed collection object
 * @throws {Error} if file is invalid YAML or not an object
 */
function readCollection(repoRoot, collectionFile) {
    const abs = path.isAbsolute(collectionFile)
        ? collectionFile
        : path.join(repoRoot, collectionFile);
    const content = fs.readFileSync(abs, 'utf8');
    const collection = yaml.load(content);
    if (!collection || typeof collection !== 'object') {
        throw new Error(`Invalid collection YAML: ${collectionFile}`);
    }
    return collection;
}
/**
 * Recursively list all files in a directory.
 * @param dirPath - Absolute path to directory
 * @param basePath - Base path for relative paths
 * @returns Array of repo-relative file paths
 */
function listFilesRecursively(dirPath, basePath) {
    const results = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            results.push(...listFilesRecursively(fullPath, basePath));
        }
        else {
            const relPath = path.relative(basePath, fullPath).replace(/\\/g, '/');
            results.push(relPath);
        }
    }
    return results;
}
/**
 * Resolve all item paths referenced in a collection.
 * For skills, expands the skill directory to include all files.
 * @param repoRoot - Repository root path
 * @param collection - Parsed collection object
 * @returns Array of normalized repo-relative paths
 */
function resolveCollectionItemPaths(repoRoot, collection) {
    const items = Array.isArray(collection.items) ? collection.items : [];
    const allPaths = [];
    for (const item of items) {
        if (!item || !item.path) {
            continue;
        }
        const normalizedPath = (0, validate_1.normalizeRepoRelativePath)(item.path);
        if (item.kind === 'skill') {
            // For skills, the path points to SKILL.md but we need the entire directory
            const skillDir = path.dirname(path.join(repoRoot, normalizedPath));
            if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
                const skillFiles = listFilesRecursively(skillDir, repoRoot);
                allPaths.push(...skillFiles);
            }
            else {
                // Fallback: just include the path as-is if directory doesn't exist
                allPaths.push(normalizedPath);
            }
        }
        else {
            allPaths.push(normalizedPath);
        }
    }
    return allPaths;
}
/**
 * Resolve the README path for a collection.
 * @param collection - Parsed collection object
 * @returns Normalized repo-relative path or null if not available
 */
function resolveCollectionReadmePath(collection) {
    if (!collection.readme || !collection.readme.path) {
        return null;
    }
    return (0, validate_1.normalizeRepoRelativePath)(collection.readme.path);
}

var bundleId = {};

/**
 * Bundle ID Generation Utilities
 * @module bundle-id
 *
 * IMPORTANT: This logic MUST stay in sync with the runtime implementation in:
 * src/utils/bundleNameUtils.ts (generateBuildScriptBundleId function)
 *
 * The bundle ID format is: {owner}-{repo}-{collectionId}-v{version}
 *
 * Any changes here should be mirrored in bundleNameUtils.ts and vice versa.
 */
Object.defineProperty(bundleId, "__esModule", { value: true });
bundleId.generateBundleId = generateBundleId;
/**
 * Generate canonical bundle ID for consistency with runtime.
 * @param repoSlug - Repository slug (owner/repo or owner-repo)
 * @param collectionId - Collection identifier
 * @param version - Version string (without 'v' prefix)
 * @returns Canonical bundle ID
 * @example
 * generateBundleId('owner/repo', 'my-collection', '1.0.0')
 * // Returns: 'owner-repo-my-collection-v1.0.0'
 */
function generateBundleId(repoSlug, collectionId, version) {
    // Normalize repo slug to use hyphens (consistent with runtime)
    const normalizedSlug = repoSlug.replace('/', '-');
    return `${normalizedSlug}-${collectionId}-v${version}`;
}

var cli = {};

/**
 * Shared CLI argument parsing utilities.
 * @module cli
 */
Object.defineProperty(cli, "__esModule", { value: true });
cli.parseSingleArg = parseSingleArg;
cli.parseMultiArg = parseMultiArg;
cli.hasFlag = hasFlag;
cli.getPositionalArg = getPositionalArg;
/**
 * Parse a single-value CLI argument.
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--collection-file')
 * @returns The value if found, undefined otherwise
 */
function parseSingleArg(argv, flag) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && argv[i + 1]) {
            return argv[i + 1];
        }
    }
    return undefined;
}
/**
 * Parse a multi-value CLI argument (can appear multiple times).
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--changed-path')
 * @returns Array of values
 */
function parseMultiArg(argv, flag) {
    const values = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && argv[i + 1]) {
            values.push(argv[i + 1]);
            i++;
        }
    }
    return values;
}
/**
 * Check if a boolean flag is present.
 * @param argv - Command line arguments
 * @param flag - Flag name (e.g., '--dry-run')
 * @returns True if flag is present
 */
function hasFlag(argv, flag) {
    return argv.includes(flag);
}
/**
 * Get positional argument at index (after filtering out flags).
 * @param argv - Command line arguments
 * @param index - Positional index (0-based)
 * @returns The positional argument if found
 */
function getPositionalArg(argv, index) {
    let posIndex = 0;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            // Skip flag and its value if it has one
            if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
                i++;
            }
            continue;
        }
        if (posIndex === index) {
            return arg;
        }
        posIndex++;
    }
    return undefined;
}

var skills = {};

(function (exports) {
	/**
	 * Skills validation module
	 *
	 * Validates skill folders following the Agent Skills specification.
	 * @see https://agentskills.io/specification
	 */
	var __createBinding = (commonjsGlobal && commonjsGlobal.__createBinding) || (Object.create ? (function(o, m, k, k2) {
	    if (k2 === undefined) k2 = k;
	    var desc = Object.getOwnPropertyDescriptor(m, k);
	    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
	      desc = { enumerable: true, get: function() { return m[k]; } };
	    }
	    Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
	    if (k2 === undefined) k2 = k;
	    o[k2] = m[k];
	}));
	var __setModuleDefault = (commonjsGlobal && commonjsGlobal.__setModuleDefault) || (Object.create ? (function(o, v) {
	    Object.defineProperty(o, "default", { enumerable: true, value: v });
	}) : function(o, v) {
	    o["default"] = v;
	});
	var __importStar = (commonjsGlobal && commonjsGlobal.__importStar) || (function () {
	    var ownKeys = function(o) {
	        ownKeys = Object.getOwnPropertyNames || function (o) {
	            var ar = [];
	            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
	            return ar;
	        };
	        return ownKeys(o);
	    };
	    return function (mod) {
	        if (mod && mod.__esModule) return mod;
	        var result = {};
	        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
	        __setModuleDefault(result, mod);
	        return result;
	    };
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.MAX_ASSET_SIZE = exports.SKILL_DESCRIPTION_MAX_LENGTH = exports.SKILL_DESCRIPTION_MIN_LENGTH = exports.SKILL_NAME_MAX_LENGTH = void 0;
	exports.parseFrontmatter = parseFrontmatter;
	exports.validateSkillName = validateSkillName;
	exports.validateSkillDescription = validateSkillDescription;
	exports.validateSkillFolder = validateSkillFolder;
	exports.validateAllSkills = validateAllSkills;
	exports.generateSkillContent = generateSkillContent;
	exports.createSkill = createSkill;
	const fs = __importStar(require$$0);
	const path = __importStar(require$$1);
	const yaml = __importStar(jsYaml);
	// Constants
	exports.SKILL_NAME_MAX_LENGTH = 64;
	exports.SKILL_DESCRIPTION_MIN_LENGTH = 10;
	exports.SKILL_DESCRIPTION_MAX_LENGTH = 1024;
	exports.MAX_ASSET_SIZE = 5 * 1024 * 1024; // 5 MB
	/**
	 * Parse YAML frontmatter from SKILL.md content
	 * @param content
	 */
	function parseFrontmatter(content) {
	    const match = content.match(/^---\n([\s\S]*?)\n---/);
	    if (!match) {
	        return null;
	    }
	    try {
	        return yaml.load(match[1]);
	    }
	    catch {
	        return null;
	    }
	}
	/**
	 * Validate skill name format
	 * @param name
	 */
	function validateSkillName(name) {
	    if (!name || typeof name !== 'string') {
	        return 'name is required and must be a string';
	    }
	    if (!/^[a-z0-9-]+$/.test(name)) {
	        return 'name must contain only lowercase letters, numbers, and hyphens';
	    }
	    if (name.length > exports.SKILL_NAME_MAX_LENGTH) {
	        return `name must not exceed ${exports.SKILL_NAME_MAX_LENGTH} characters`;
	    }
	    return null;
	}
	/**
	 * Validate skill description
	 * @param description
	 */
	function validateSkillDescription(description) {
	    if (!description || typeof description !== 'string') {
	        return 'description is required and must be a string';
	    }
	    if (description.length < exports.SKILL_DESCRIPTION_MIN_LENGTH) {
	        return `description must be at least ${exports.SKILL_DESCRIPTION_MIN_LENGTH} characters`;
	    }
	    if (description.length > exports.SKILL_DESCRIPTION_MAX_LENGTH) {
	        return `description must not exceed ${exports.SKILL_DESCRIPTION_MAX_LENGTH} characters`;
	    }
	    return null;
	}
	/**
	 * Validate a single skill folder
	 * @param folderPath
	 * @param folderName
	 */
	function validateSkillFolder(folderPath, folderName) {
	    const errors = [];
	    let skillName = folderName;
	    // Check if SKILL.md exists
	    const skillFile = path.join(folderPath, 'SKILL.md');
	    if (!fs.existsSync(skillFile)) {
	        return {
	            skillName,
	            folderName,
	            valid: false,
	            errors: ['Missing SKILL.md file']
	        };
	    }
	    // Read and parse frontmatter
	    const content = fs.readFileSync(skillFile, 'utf8');
	    const metadata = parseFrontmatter(content);
	    if (!metadata) {
	        return {
	            skillName,
	            folderName,
	            valid: false,
	            errors: ['Failed to parse SKILL.md frontmatter']
	        };
	    }
	    skillName = metadata.name || folderName;
	    // Validate name field
	    const nameError = validateSkillName(metadata.name);
	    if (nameError) {
	        errors.push(`name: ${nameError}`);
	    }
	    else if (metadata.name !== folderName) {
	        errors.push(`Folder name "${folderName}" does not match skill name "${metadata.name}"`);
	    }
	    // Validate description field
	    const descError = validateSkillDescription(metadata.description);
	    if (descError) {
	        errors.push(`description: ${descError}`);
	    }
	    // Check for reasonable file sizes in bundled assets
	    const files = fs.readdirSync(folderPath);
	    for (const file of files) {
	        if (file === 'SKILL.md') {
	            continue;
	        }
	        const filePath = path.join(folderPath, file);
	        try {
	            const stats = fs.statSync(filePath);
	            if (stats.isFile() && stats.size > exports.MAX_ASSET_SIZE) {
	                const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
	                errors.push(`Bundled asset "${file}" exceeds maximum size of 5MB (${sizeMB}MB)`);
	            }
	        }
	        catch (error) {
	            errors.push(`Cannot access bundled asset "${file}": ${error.message}`);
	        }
	    }
	    return {
	        skillName,
	        folderName,
	        valid: errors.length === 0,
	        errors
	    };
	}
	/**
	 * Validate all skills in a directory
	 * @param repoRoot
	 * @param skillsDir
	 */
	function validateAllSkills(repoRoot, skillsDir = 'skills') {
	    const skillsPath = path.join(repoRoot, skillsDir);
	    if (!fs.existsSync(skillsPath)) {
	        return {
	            valid: true,
	            skills: [],
	            totalSkills: 0,
	            validSkills: 0,
	            invalidSkills: 0
	        };
	    }
	    const skillFolders = fs.readdirSync(skillsPath).filter((file) => {
	        const filePath = path.join(skillsPath, file);
	        return fs.statSync(filePath).isDirectory();
	    });
	    if (skillFolders.length === 0) {
	        return {
	            valid: true,
	            skills: [],
	            totalSkills: 0,
	            validSkills: 0,
	            invalidSkills: 0
	        };
	    }
	    const results = [];
	    const usedNames = new Set();
	    let hasErrors = false;
	    for (const folder of skillFolders) {
	        const folderPath = path.join(skillsPath, folder);
	        const result = validateSkillFolder(folderPath, folder);
	        // Check for duplicate names
	        if (result.valid && usedNames.has(result.skillName)) {
	            result.valid = false;
	            result.errors.push(`Duplicate skill name "${result.skillName}"`);
	        }
	        else if (result.valid) {
	            usedNames.add(result.skillName);
	        }
	        if (!result.valid) {
	            hasErrors = true;
	        }
	        results.push(result);
	    }
	    return {
	        valid: !hasErrors,
	        skills: results,
	        totalSkills: results.length,
	        validSkills: results.filter((r) => r.valid).length,
	        invalidSkills: results.filter((r) => !r.valid).length
	    };
	}
	/**
	 * Generate SKILL.md content
	 * @param name
	 * @param description
	 */
	function generateSkillContent(name, description) {
	    return `---
name: ${name}
description: "${description}"
---

# ${name}

${description}

## Capabilities

Describe what this skill enables Copilot to do.

## Usage

Explain when and how Copilot should use this skill.

## Examples

Provide example interactions or use cases.
`;
	}
	/**
	 * Create a new skill directory structure
	 * @param repoRoot
	 * @param skillName
	 * @param description
	 * @param skillsDir
	 */
	function createSkill(repoRoot, skillName, description, skillsDir = 'skills') {
	    // Validate inputs
	    const nameError = validateSkillName(skillName);
	    if (nameError) {
	        return { success: false, path: '', error: nameError };
	    }
	    const descError = validateSkillDescription(description);
	    if (descError) {
	        return { success: false, path: '', error: descError };
	    }
	    const skillsPath = path.join(repoRoot, skillsDir);
	    const skillPath = path.join(skillsPath, skillName);
	    if (fs.existsSync(skillPath)) {
	        return { success: false, path: skillPath, error: `Skill "${skillName}" already exists` };
	    }
	    try {
	        // Ensure skills directory exists
	        if (!fs.existsSync(skillsPath)) {
	            fs.mkdirSync(skillsPath, { recursive: true });
	        }
	        // Create skill folder
	        fs.mkdirSync(skillPath, { recursive: true });
	        // Create SKILL.md
	        const content = generateSkillContent(skillName, description);
	        fs.writeFileSync(path.join(skillPath, 'SKILL.md'), content);
	        return { success: true, path: skillPath };
	    }
	    catch (error) {
	        return { success: false, path: skillPath, error: error.message };
	    }
	}
	
} (skills));

(function (exports) {
	/**
	 * `@prompt-registry/collection-scripts`
	 *
	 * Shared scripts for building, validating, and publishing Copilot prompt collections.
	 * @module @prompt-registry/collection-scripts
	 */
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createSkill = exports.generateSkillContent = exports.validateAllSkills = exports.validateSkillFolder = exports.validateSkillDescription = exports.validateSkillName = exports.parseFrontmatter = exports.MAX_ASSET_SIZE = exports.SKILL_DESCRIPTION_MAX_LENGTH = exports.SKILL_DESCRIPTION_MIN_LENGTH = exports.SKILL_NAME_MAX_LENGTH = exports.getPositionalArg = exports.hasFlag = exports.parseMultiArg = exports.parseSingleArg = exports.generateBundleId = exports.resolveCollectionReadmePath = exports.resolveCollectionItemPaths = exports.readCollection = exports.listCollectionFiles = exports.generateMarkdown = exports.validateAllCollections = exports.validateCollectionFile = exports.validateCollectionObject = exports.isSafeRepoRelativePath = exports.normalizeRepoRelativePath = exports.validateItemKind = exports.validateVersion = exports.validateCollectionId = exports.loadItemKindsFromSchema = exports.VALIDATION_RULES = void 0;
	// Validation exports
	var validate_1 = validate;
	Object.defineProperty(exports, "VALIDATION_RULES", { enumerable: true, get: function () { return validate_1.VALIDATION_RULES; } });
	Object.defineProperty(exports, "loadItemKindsFromSchema", { enumerable: true, get: function () { return validate_1.loadItemKindsFromSchema; } });
	Object.defineProperty(exports, "validateCollectionId", { enumerable: true, get: function () { return validate_1.validateCollectionId; } });
	Object.defineProperty(exports, "validateVersion", { enumerable: true, get: function () { return validate_1.validateVersion; } });
	Object.defineProperty(exports, "validateItemKind", { enumerable: true, get: function () { return validate_1.validateItemKind; } });
	Object.defineProperty(exports, "normalizeRepoRelativePath", { enumerable: true, get: function () { return validate_1.normalizeRepoRelativePath; } });
	Object.defineProperty(exports, "isSafeRepoRelativePath", { enumerable: true, get: function () { return validate_1.isSafeRepoRelativePath; } });
	Object.defineProperty(exports, "validateCollectionObject", { enumerable: true, get: function () { return validate_1.validateCollectionObject; } });
	Object.defineProperty(exports, "validateCollectionFile", { enumerable: true, get: function () { return validate_1.validateCollectionFile; } });
	Object.defineProperty(exports, "validateAllCollections", { enumerable: true, get: function () { return validate_1.validateAllCollections; } });
	Object.defineProperty(exports, "generateMarkdown", { enumerable: true, get: function () { return validate_1.generateMarkdown; } });
	// Collection utilities exports
	var collections_1 = collections;
	Object.defineProperty(exports, "listCollectionFiles", { enumerable: true, get: function () { return collections_1.listCollectionFiles; } });
	Object.defineProperty(exports, "readCollection", { enumerable: true, get: function () { return collections_1.readCollection; } });
	Object.defineProperty(exports, "resolveCollectionItemPaths", { enumerable: true, get: function () { return collections_1.resolveCollectionItemPaths; } });
	Object.defineProperty(exports, "resolveCollectionReadmePath", { enumerable: true, get: function () { return collections_1.resolveCollectionReadmePath; } });
	// Bundle ID exports
	var bundle_id_1 = bundleId;
	Object.defineProperty(exports, "generateBundleId", { enumerable: true, get: function () { return bundle_id_1.generateBundleId; } });
	// CLI utilities exports
	var cli_1 = cli;
	Object.defineProperty(exports, "parseSingleArg", { enumerable: true, get: function () { return cli_1.parseSingleArg; } });
	Object.defineProperty(exports, "parseMultiArg", { enumerable: true, get: function () { return cli_1.parseMultiArg; } });
	Object.defineProperty(exports, "hasFlag", { enumerable: true, get: function () { return cli_1.hasFlag; } });
	Object.defineProperty(exports, "getPositionalArg", { enumerable: true, get: function () { return cli_1.getPositionalArg; } });
	var skills_1 = skills;
	Object.defineProperty(exports, "SKILL_NAME_MAX_LENGTH", { enumerable: true, get: function () { return skills_1.SKILL_NAME_MAX_LENGTH; } });
	Object.defineProperty(exports, "SKILL_DESCRIPTION_MIN_LENGTH", { enumerable: true, get: function () { return skills_1.SKILL_DESCRIPTION_MIN_LENGTH; } });
	Object.defineProperty(exports, "SKILL_DESCRIPTION_MAX_LENGTH", { enumerable: true, get: function () { return skills_1.SKILL_DESCRIPTION_MAX_LENGTH; } });
	Object.defineProperty(exports, "MAX_ASSET_SIZE", { enumerable: true, get: function () { return skills_1.MAX_ASSET_SIZE; } });
	Object.defineProperty(exports, "parseFrontmatter", { enumerable: true, get: function () { return skills_1.parseFrontmatter; } });
	Object.defineProperty(exports, "validateSkillName", { enumerable: true, get: function () { return skills_1.validateSkillName; } });
	Object.defineProperty(exports, "validateSkillDescription", { enumerable: true, get: function () { return skills_1.validateSkillDescription; } });
	Object.defineProperty(exports, "validateSkillFolder", { enumerable: true, get: function () { return skills_1.validateSkillFolder; } });
	Object.defineProperty(exports, "validateAllSkills", { enumerable: true, get: function () { return skills_1.validateAllSkills; } });
	Object.defineProperty(exports, "generateSkillContent", { enumerable: true, get: function () { return skills_1.generateSkillContent; } });
	Object.defineProperty(exports, "createSkill", { enumerable: true, get: function () { return skills_1.createSkill; } });
	
} (dist));

/**
 * Collection Validation GitHub Action
 *
 * Validates prompt registry collection files by delegating to the shared
 * `@prompt-registry/collection-scripts` library — the single source of truth
 * for collection validation (valid item kinds are loaded from the JSON schema).
 *
 * Attribution: Inspired by github/awesome-copilot
 * https://github.com/github/awesome-copilot
 */


// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

function main() {
    console.log(`${colors.cyan}${colors.bold}📋 Collection Validation${colors.reset}\n`);
    console.log(`${colors.cyan}Attribution: Inspired by github/awesome-copilot${colors.reset}`);
    console.log(`${colors.cyan}https://github.com/github/awesome-copilot${colors.reset}\n`);

    const repoRoot = process.cwd();
    const collectionsDir = path$1.join(repoRoot, 'collections');

    if (!fs$1.existsSync(collectionsDir)) {
        console.error(`${colors.red}❌ Error: Collections directory not found: ${collectionsDir}${colors.reset}`);
        process.exit(1);
    }

    const files = dist.listCollectionFiles(repoRoot);

    if (files.length === 0) {
        console.log(`${colors.yellow}⚠️  No collection files found in ${collectionsDir}${colors.reset}`);
        process.exit(0);
    }

    console.log(`Found ${files.length} collection(s)\n`);

    // Delegate to the shared validator (includes duplicate id/name detection).
    const result = dist.validateAllCollections(repoRoot, files);

    result.fileResults.forEach((fileResult) => {
        console.log(`Validating: ${colors.bold}${fileResult.file}${colors.reset}`);
        if (fileResult.ok) {
            console.log(`  ${colors.green}✓ Valid${colors.reset}`);
        } else {
            fileResult.errors.forEach((err) => {
                console.log(`  ${colors.red}✗ Error: ${err}${colors.reset}`);
            });
        }
        console.log('');
    });
    const validCollections = result.fileResults.filter((r) => r.ok).length;

    // Cross-collection errors (duplicate collection id/name) are not tied to a
    // single file's result — surface them separately.
    const crossCollectionErrors = result.errors.filter((e) => e.includes('Duplicate collection'));
    if (crossCollectionErrors.length > 0) {
        console.log(`${colors.red}Cross-collection errors:${colors.reset}`);
        crossCollectionErrors.forEach((err) => {
            console.log(`  ${colors.red}✗ ${err}${colors.reset}`);
        });
        console.log('');
    }

    console.log('='.repeat(60));
    console.log(`Summary: ${validCollections}/${files.length} collections valid`);
    console.log(`${result.ok ? colors.green : colors.red}Total Errors: ${result.errors.length}${colors.reset}`);
    console.log('='.repeat(60));

    if (result.ok) {
        console.log(`\n${colors.green}✅ All collections valid!${colors.reset}`);
        process.exit(0);
    } else {
        console.log(`\n${colors.red}❌ Validation failed${colors.reset}`);
        process.exit(1);
    }
}

main();
//# sourceMappingURL=index.js.map
