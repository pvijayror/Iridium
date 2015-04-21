﻿/// <reference path='../typings/node/node.d.ts' />
/// <reference path='../typings/mongodb/mongodb.d.ts' />
/// <reference path='../typings/lodash/lodash.d.ts' />
/// <reference path='../typings/bluebird/bluebird.d.ts' />
/// <reference path="Core.ts" />
/// <reference path="Model.ts" />

import iridium = require('./Core');
import model = require('./Model');
import IPlugin = require('./Plugins');
import _ = require('lodash');
import Promise = require('bluebird');

import general = require('./General');

class Instance<TDocument, TInstance> {
    /**
     * Creates a new instance which represents the given document as a type of model
     * @param {model.Model} model The model that the document represents
     * @param {TSchema} document The document which should be wrapped by this instance
     * @param {Boolean} isNew Whether the document is new (doesn't exist in the database) or not
     * @param {Boolean} isPartial Whether the document has only a subset of its fields populated
     * @description
     * This class will be subclassed automatically by Iridium to create a model specific instance
     * which takes advantage of some of v8's optimizations to boost performance significantly.
     * The instance returned by the model, and all of this instance's methods, will be of type
     * TInstance - which should represent the merger of TSchema and IInstance for best results.
     */
    constructor(model: model.Model<TDocument, TInstance>, document: TDocument, isNew: boolean = false, isPartial: boolean = false) {
        this._model = model;

        this._isNew = !!isNew;
        this._isPartial = isPartial;
        this._original = document;
        this._modified = _.cloneDeep(document);

        _.each(model.core.plugins, function (plugin: IPlugin) {
            if (plugin.newInstance) plugin.newInstance(this, model);
        });
    }

    private _isNew: boolean;
    private _isPartial: boolean;
    private _model: model.Model<TDocument, TInstance>;
    private _original: TDocument;
    private _modified: TDocument;

    /**
     * Gets the underlying document representation of this instance
     */
    get document(): TDocument {
        return this._modified;
    }

    [name: string]: any;

    /**
     * Saves any changes to this instance, using the built in diff algorithm to write the update query.
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(callback?: general.Callback<TInstance>): Promise<TInstance>;
    /**
     * Saves the given changes to this instance and updates the instance to match the latest database document.
     * @param {Object} changes The MongoDB changes object to be used when updating this instance
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(changes: Object, callback?: general.Callback<TInstance>): Promise<TInstance>;
    /**
     * Saves the given changes to this instance and updates the instance to match the latest database document.
     * @param {Object} conditions The conditions under which the update will take place - these will be merged with an _id query
     * @param {Object} changes The MongoDB changes object to be used when updating this instance
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(conditions: Object, changes: Object, callback?: general.Callback<TInstance>): Promise<TInstance>;
    save(...args: any[]): Promise<TInstance> {
        var callback: general.Callback<any> = null;
        var changes: any = null;
        var conditions: any = {};

        Array.prototype.slice.call(args, 0).reverse().forEach(function (arg) {
            if (typeof arg == 'function') callback = arg;
            else if (typeof arg == 'object') {
                if (!changes) changes = arg;
                else conditions = arg;
            }
        });

        return Promise.resolve().then(function () {
            _.merge(conditions, this._model.helpers.selectOneDownstream(this._modified));

            this._model.helpers.transform.reverse(conditions);

            if (!changes) {
                var validation = this._model.helpers.validate(this._modified);
                if (validation.failed) return Promise.reject(validation.error).bind(this).nodeify(callback);

                var original = _.cloneDeep(this._original);
                var modified = _.cloneDeep(this._modified);

                changes = this._model.helpers.diff(original, modified);
            }
        }).then(function () {
            return this._model.handlers.savingDocument(this, changes);
        }).then(function () {
            return new Promise<boolean>(function (resolve: (changed: boolean) => void, reject) {
                this._model.collection.update(conditions, changes, { w: 1 }, function (err: Error, changed: boolean) {
                    if (err) return reject(err);
                    return resolve(changed);
                });
            });
        }).then(function (changed: boolean) {
            conditions = this._model.helpers.selectOne(this.modified);
            if (!changed) return this._modified;

            return new Promise<any>(function (resolve, reject) {
                this._model.collection.findOne(conditions, function (err: Error, latest) {
                    if (err) return reject(err);
                    return resolve(latest);
                });
            });
        }).then(function (latest) {
            return this._model.handlers.documentsReceived(conditions, [latest], function (value) {
                this._model.helpers.transform.apply(value);
                this._isPartial = false;
                this._isNew = false;
                this._original = value;
                this._modified = _.clone(value);
                return this;
            });
        }).nodeify(callback);
    }

    /**
     * Updates this instance to match the latest document available in the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the update completes
     * @returns {Promise<TInstance>}
     */
    update(callback?: general.Callback<TInstance>): Promise<TInstance> {
        return this.refresh(callback);
    }

    /**
     * Updates this instance to match the latest document available in the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the update completes
     * @returns {Promise<TInstance>}
     */
    refresh(callback?: general.Callback<TInstance>): Promise<TInstance> {
        var conditions = this._model.helpers.selectOne(this._original);

        return Promise.resolve().then(function () {
            return new Promise<any>(function (resolve, reject) {
                this._model.collection.findOne(conditions, function (err: Error, doc: any) {
                    if (err) return reject(err);
                    return resolve(doc);
                });
            });
        }).then(function (doc) {
            if (!doc) {
                this._isPartial = true;
                this._isNew = true;
                this._original = _.cloneDeep(this._modified);
                return this;
            }

            return this._model.handle.documentsReceived(conditions, [doc], this._model.helpers.transform.apply, { wrap: false }).then(function (doc: any) {
                this._model.helpers.transformFromSource(doc);
                this._isNew = false;
                this._isPartial = false;
                this._original = doc;
                this._modified = _.cloneDeep(doc);

                this._model._helpers.transformDown(doc);

                return this;
            });
        }).nodeify(callback);
    }

    /**
     * Removes this instance's document from the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the operation completes
     * @returns {Promise<TInstance>}
     */
    delete(callback?: general.Callback<TInstance>): Promise<TInstance> {
        return this.remove(callback);
    }

    /**
     * Removes this instance's document from the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the operation completes
     * @returns {Promise<TInstance>}
     */
    remove(callback?: general.Callback<TInstance>): Promise<TInstance> {
        var conditions = this._model.helpers.selectOne(this._original);

        return Promise.resolve().then(function () {
            if (this._isNew) return 0;
            return new Promise<number>(function (resolve: (value: number) => void, reject) {
                this._model.collection.remove(conditions, function (err: Error, removed?: number) {
                    if (err) return reject(err);
                    return resolve(removed);
                });
            });
        }).then(function (removed) {
            if (removed) return this._model.cache.remove(conditions);
        }).nodeify(callback);
    }

    /**
     * Retrieves the first element in an enumerable collection which matches the predicate
     * @param {any[]} collection The collection from which to retrieve the element
     * @param {function(any, Number): Boolean} predicate The function which determines whether to select an element
     * @returns {any}
     */
    first<T>(collection: T[], predicate: general.Predicate<T>): T;
    /**
     * Retrieves the first element in an enumerable collection which matches the predicate
     * @param {Object} collection The collection from which to retrieve the element
     * @param {function(any, String): Boolean} predicate The function which determines whether to select an element
     * @returns {any}
     */
    first<T>(collection: { [key: string]: T }, predicate: general.Predicate<T>): T;
    first<T>(collection: T[]| { [key: string]: T }, predicate: general.Predicate<T>): T {
        var result = null;

        _.each(collection, function (value: T, key) {
            if (predicate.call(this, value, key)) {
                result = value;
                return false;
            }
        }, this);

        return result;
    }

    /**
     * Retrieves a number of elements from an enumerable collection which match the predicate
     * @param {any[]} collection The collection from which elements will be plucked
     * @param {function(any, Number): Boolean} predicate The function which determines the elements to be plucked
     * @returns {any[]}
     */
    select<T>(collection: T[], predicate: general.Predicate<T>): T[];
    /**
     * Retrieves a number of elements from an enumerable collection which match the predicate
     * @param {Object} collection The collection from which elements will be plucked
     * @param {function(any, String): Boolean} predicate The function which determines the elements to be plucked
     * @returns {Object}
     */
    select<T>(collection: { [key: string]: T }, predicate: general.Predicate<T>): { [key: string]: T };
    select<T>(collection: T[]| { [key: string]: T }, predicate: general.Predicate<T>): any {
        var isArray = Array.isArray(collection);
        var results: any = isArray ? [] : {};

        _.each(collection, function (value: T, key) {
            if (predicate.call(this, value, key)) {
                if (isArray) results.push(value);
                else results[key] = value;
            }
        }, this);

        return results;
    }
}

export = Instance;