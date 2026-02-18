/**
 * Pulls characters from the string iterator while the predicate remains true.
 */
function consumeWhile(
	iterator: Iterator<string>,
	predicate: (str: string) => boolean
) {
	let next = iterator.next();
	let str = "";
	while (!next.done) {
		str += next.value;
		if (!predicate(str)) {
			break;
		}
		next = iterator.next();
	}
	return str;
}

/**
 * Pulls characters from the string iterator until the `endMarker` is found.
 */
function consumeUntilMarker(iterator: Iterator<string>, endMarker: string) {
	return consumeWhile(iterator, (str) => !str.endsWith(endMarker));
}

/**
 * Returns true if the `str` ends with a dollar-quoted string marker.
 * See https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING.
 */
function isDollarQuoteIdentifier(str: string) {
	const lastChar = str.slice(-1);
	return (
		// The $ marks the end of the identifier
		lastChar !== "$" &&
		// we allow numbers, underscore and letters with diacritical marks
		(/[0-9_]/i.test(lastChar) ||
			lastChar.toLowerCase() !== lastChar.toUpperCase())
	);
}

/**
 * Returns true if the `str` ends with a compound statement `BEGIN` or `CASE` marker.
 */
function isCompoundStatementStart(str: string) {
	return /\s(BEGIN|CASE)\s$/i.test(str);
}

/**
 * Returns true if the `str` ends with a compound statement `END` marker.
 */
function isCompoundStatementEnd(str: string) {
	return /\sEND[;\s]$/.test(str);
}

/**
 * Escapes a SQL value for safe inclusion in a SQL statement.
 * @param value - The value to escape (string, number, null, or ArrayBuffer)
 * @returns SQL-safe string representation of the value
 */
function escapeSqlValue(value: ArrayBuffer | string | number | null): string {
    if (value === null) {
        return "NULL";
    }

    if (typeof value === "string") {
        // Escape single quotes by doubling them
        return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "number") {
        return value.toString();
    }

    if (value instanceof ArrayBuffer) {
        // Convert ArrayBuffer to hex string (SQLite blob format: X'hexstring')
        const bytes = new Uint8Array(value);
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        return `X'${hex}'`;
    }

    throw new Error(`Unsupported value type: ${typeof value}`);
}
/**
 * Replaces `?` placeholders in SQL with actual parameter values.
 * Properly handles string literals, comments, etc.
 * TODO - add support for named and indexed parameters, create tests in tests/utils
 * @param sql - The SQL string with ? placeholders
 * @param params - Array of parameter values to substitute
 * @returns SQL string with placeholders replaced by values
 */
export function replaceSqlPlaceholders(sql: string, params: any[]): string {
	let result = "";
	let paramIndex = 0;

	const iterator = sql[Symbol.iterator]();
	let next = iterator.next();
	while (!next.done) {
		const char = next.value;

		switch (char) {
			case "'":
			case '"':
			case "\`":
				result += char + consumeUntilMarker(iterator, char);
				break;
			case "$": {
				const dollarQuote =
					"$" + consumeWhile(iterator, isDollarQuoteIdentifier);
				result += dollarQuote;
				if (dollarQuote.endsWith("$")) {
					result += consumeUntilMarker(iterator, dollarQuote);
				}
				break;
			}
			case "-":
				next = iterator.next();
				if (!next.done && next.value === "-") {
					// Include the comment in result
					result += "--" + consumeUntilMarker(iterator, "\n");
					break;
				} else {
					result += char;
					continue;
				}
			case "/":
				next = iterator.next();
				if (!next.done && next.value === "*") {
					// Include the comment in result
					result += "/*" + consumeUntilMarker(iterator, "*/");
					break;
				} else {
					result += char;
					continue;
				}
			case "?":
				// Replace placeholder with parameter value
				if (paramIndex >= params.length) {
					throw new Error(`Not enough parameters provided. Expected at least ${paramIndex + 1} but got ${params.length}`);
				}
				let val = params[paramIndex++];
				// Handle objects and arrays by stringifying them
				if (val !== null && (typeof val === 'object' || Array.isArray(val))) {
					val = JSON.stringify(val);
				}
				result += escapeSqlValue(val);
				break;
			default:
				result += char;
				break;
		}

		next = iterator.next();
	}

	return result;
}

