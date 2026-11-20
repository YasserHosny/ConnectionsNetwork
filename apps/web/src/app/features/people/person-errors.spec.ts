import { ApiError } from '../../core/api.client';
import { actionErrorKey, isMfaRequired, isRetryable, personErrorMessage } from './person-errors';

describe('personErrorMessage', () => {
  it('treats an unanswered request and a server error as retryable, nothing else', () => {
    expect(isRetryable(new ApiError('network_error', 'x', 0))).toBeTrue();
    expect(isRetryable(new ApiError('internal_error', 'x', 500))).toBeTrue();
    expect(isRetryable(new ApiError('http_error', 'x', 503))).toBeTrue();
    expect(isRetryable(new ApiError('validation.invalid_request', 'x', 422))).toBeFalse();
    expect(isRetryable(new ApiError('conflict', 'x', 409))).toBeFalse();
  });

  it('keeps the entry on the device for a retryable failure', () => {
    expect(personErrorMessage(new ApiError('network_error', 'x', 0))).toEqual({
      key: 'person.errors.savedOnDevice',
      fieldKey: null,
      retryable: true,
    });
  });

  it('maps a missing name from the request validation details', () => {
    const error = new ApiError('validation.invalid_request', 'x', 422, [
      { loc: ['body', 'person'], type: 'value_error', field: 'person', msg: 'Value error, name_ar or name_latin is required' },
    ]);

    expect(personErrorMessage(error).key).toBe('person.errors.nameRequired');
  });

  it('names the rejected field', () => {
    const error = new ApiError('validation.invalid_request', 'x', 422, [
      { field: 'person.skills[0].label', type: 'string_too_long' },
    ]);

    expect(personErrorMessage(error)).toEqual({
      key: 'person.errors.invalidField',
      fieldKey: 'person.form.skills',
      retryable: false,
    });
  });

  it('maps a missing person, a duplicate connection, a missing resource and the auth statuses', () => {
    const invalid = (reason: string) =>
      new ApiError('validation.invalid_value', 'x', 422, { field: 'connect_to_person_id', reason });

    expect(personErrorMessage(invalid('person_not_found')).key).toBe('person.errors.personNotFound');
    expect(personErrorMessage(new ApiError('conflict', 'x', 409, { reason: 'already_connected' })).key).toBe(
      'person.errors.alreadyConnected',
    );
    expect(personErrorMessage(new ApiError('not_found', 'x', 404)).key).toBe('person.errors.notFound');
    expect(personErrorMessage(new ApiError('auth.unauthenticated', 'x', 401)).key).toBe('person.errors.sessionEnded');
    expect(personErrorMessage(new ApiError('auth.forbidden', 'x', 403)).key).toBe('person.errors.forbidden');
  });

  it('falls back to a generic message for anything unknown, never the API text', () => {
    const message = personErrorMessage(new ApiError('weird', 'English API text', 418));

    expect(message.key).toBe('person.errors.generic');
  });
});

describe('actionErrorKey', () => {
  it('says the server could not be reached for a network or server failure', () => {
    expect(actionErrorKey(new ApiError('network_error', 'x', 0))).toBe('person.errors.unreachable');
    expect(actionErrorKey(new ApiError('internal_error', 'x', 500))).toBe('person.errors.unreachable');
  });

  it('maps the delete-self conflict, a missing person and the auth statuses', () => {
    expect(actionErrorKey(new ApiError('cannot_delete_self', 'x', 409))).toBe('person.errors.cannotDeleteSelf');
    expect(actionErrorKey(new ApiError('not_found', 'x', 404))).toBe('person.errors.notFound');
    expect(actionErrorKey(new ApiError('auth.unauthenticated', 'x', 401))).toBe('person.errors.sessionEnded');
    expect(actionErrorKey(new ApiError('auth.forbidden', 'x', 403))).toBe('person.errors.forbidden');
  });

  it('falls back to a generic message, never the API text', () => {
    expect(actionErrorKey(new ApiError('weird', 'English API text', 418))).toBe('person.errors.generic');
  });

  it('recognises a lapsed MFA step', () => {
    expect(isMfaRequired(new ApiError('mfa_required', 'x', 403))).toBeTrue();
    expect(isMfaRequired(new ApiError('auth.forbidden', 'x', 403))).toBeFalse();
  });
});
