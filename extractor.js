/**
 * Created by igorgo on 05.07.2017.
 */
const utils = require('./utils'),
    xpath = require('xpath'),
    Dom = require('xmldom').DOMParser,
    tomlify = require('tomlify-j0.4'),
    path = require('path')

const CONTEXTS = {
        0: 'Идентификатор записи',
        1: 'Идентификатор родительской записи',
        2: 'Идентификатор каталога',
        3: 'Идентификатор организации',
        4: 'Идентификатор версии',
        5: 'Код раздела',
        6: 'Код родительского раздела',
        7: 'Пользователь',
        8: 'NULL',
        9: 'Идентификатор отмеченных записей',
        10: 'Код мастер раздела',
        11: 'Идентификатор процесса',
        12: 'Идентификатор мастер записи',
        13: 'Метод вызова раздела'
    },
    SHOWMETHOD_FORM_KIND = 5,
    ACTION_FORM_KIND = 3


const nullEmptyArray = (array) => {
    return (Array.isArray(array) && array.length > 0) ? array : null
}

class Extractor {
    constructor() {
        let gVars = require('./index')
        this.language = gVars.language
        this.R = require('./res/strings/extractor-' + this.language)
        this.oci = gVars.oci
    }

    async extractClass(classCode, dir) {
        this.classCode = classCode
        this.classInfo = await this._getClassInfo()
        this.className = ''
        if (this.language === 'ru') this.className = ' - ' + this.classInfo.RU
        if (this.language === 'uk') this.className = ' - ' + this.classInfo.UK
        //utils.conE(`${this.R.procClass} ${this.classCode}${this.className}…`)
        this.dir = path.posix.normalize(dir)
        this.classDir = path.posix.join(this.dir, this.classInfo.path.replace(/\//g, '/SubClasses/'))
        this.classRn = this.classInfo.rn
        let promises = await Promise.all([this._getDomainsMeta(), this._getClassMeta()])
        utils.conE(`… ${this.R.classWord} ${this.classCode}${this.className} ${this.R.classReady}.`)
        const tomlContent = {
            'Используемые домены': {
                'Домен': promises[0].toml//await this._getDomainsMeta()
            },
            'Класс': promises[1].toml // await this._getClassMeta()
        }
        const jsonContent = {
            'usingDomains': promises[0].json,
            'class': promises[1].json
        }
        await utils.saveTextFile(tomlify(tomlContent, null, 4), this.classDir, 'Metadata.toml')
        await utils.saveTextFile(JSON.stringify(jsonContent, null, 4), this.classDir, 'Metadata.json')
        return {
            classRn: this.classRn,
            classCode: this.classCode,
            classDir: this.classDir
        }
    }

    async _saveIcons(savePath, code) {
        let query = await this.oci.executeAndStayOpen(
            ' select SY.*  from SYSIMAGES SY  where code = :CODE',
            [code]
        )
        let icon = query.rows[0]
        await utils.saveBlob(icon['SMALL_IMAGE'], savePath, `${icon['CODE']}_16.bmp`)
        await utils.saveBlob(icon['LARGE_IMAGE'], savePath, `${icon['CODE']}_24.bmp`)
        query.conn.close()
    }

    async _getResources(rn, tab, col) {
        let res = {
            RU: null,
            UK: null
        }
        let r = await
            this.oci.execute(`
        select RESOURCE_LANG,
               RESOURCE_TEXT
          from RESOURCES
         where TABLE_NAME = :ATAB
           and RESOURCE_NAME = :ACOL
           and TABLE_ROW = :ANRN`,
                {
                    'ATAB': tab,
                    'ACOL': col,
                    'ANRN': rn
                })
        for (let i = 0, len = r.rows.length; i < len; i++) {
            if (r.rows[i]['RESOURCE_LANG'] === 'RUSSIAN') res.RU = (r.rows[i]['RESOURCE_TEXT'])
            if (r.rows[i]['RESOURCE_LANG'] === 'UKRAINIAN') res.UK = (r.rows[i]['RESOURCE_TEXT'])
        }
        return res
    }

    async _getClassInfo() {
        let r = await this.oci.execute(`
            select RN, PATH
              from (select U.UNITCODE,
                           U.RN,
                           SUBSTR(SYS_CONNECT_BY_PATH(U.UNITCODE, '/'), 2) as PATH
                      from UNITLIST U
                     start with U.PARENTCODE is null
                    connect by U.PARENTCODE = prior U.UNITCODE)
             where UNITCODE = :CLASSCODE`,
            [this.classCode]
        )
        if (r.rows.length > 0) {
            const names = await this._getResources(r.rows[0]['RN'], 'UNITLIST', 'UNITNAME')
            return {
                rn: r.rows[0]['RN'],
                path: r.rows[0]['PATH'],
                RU: names.RU,
                UK: names.UK
            }
        }
        else {
            throw this.R.clNotFnd
        }
    }

    async _getDomainsMeta() {
        let domainsMeta = await this._getMetadataDomainList()
        let domainsCond = await this._getConditionDomainList()
        let domains = [...new Set(domainsMeta.concat(domainsCond))].sort()
        let domainsDataToml = []
        let domainsDataJson = []
        for (let i = 0; i < domains.length; i++) {
            let r = await this.oci.execute(`
                 select D.RN,
                        D.CODE,
                        DT.DATATYPE_TEXT,
                        DT.DATATYPE_SUBTEXT,
                        D.DATA_LENGTH,
                        D.DATA_PRECISION,
                        D.DATA_SCALE,
                        D.DEFAULT_STR,
                        D.DEFAULT_NUM,
                        D.DEFAULT_DATE,
                        D.ENUMERATED,
                        D.PADDING
                   from DMSDOMAINS D, V_DATATYPES DT
                  where D.CODE = :DOMAINCODE
                    and D.DATA_TYPE = DT.DATATYPE_NUMB
                    and D.DATA_SUBTYPE = DT.DATATYPE_SUBNUMB            
            `, [domains[i]])
            let domain = r.rows[0]
            let name = await this._getResources(domain['RN'], 'DMSDOMAINS', 'NAME')
            const enums = await this._getDomainEnums(domain['RN'])
            let tomlDomain = {
                'Мнемокод': domain['CODE'],
                'Наименование (RU)': name.RU,
                'Наименование (UK)': name.UK,
                'Тип данных': domain['DATATYPE_TEXT'],
                'Подтип данных': domain['DATATYPE_SUBTEXT'],
                'Размер строки': domain['DATA_LENGTH'],
                'Точность данных': domain['DATA_PRECISION'],
                'Дробность данных': domain['DATA_SCALE'],
                'Значение по умолчанию': utils.coalesce(domain['DEFAULT_STR'], domain['DEFAULT_NUM'], domain['DEFAULT_DATE']),
                'Выравнивать по длине': !!domain['PADDING'],
                'Имеет перечисляемые значения': !!domain['ENUMERATED'],
                'Перечисляемые значения': domain['ENUMERATED'] ?
                    {'Перечисляемое значение': enums.toml}
                    : null
            }
            let jsonDomain = {
                'CODE': domain['CODE'],
                'NAME': name,
                'DATA_TYPE': domain['DATATYPE_TEXT'],
                'DATA_SUBTYPE': domain['DATATYPE_SUBTEXT'],
                'DATA_LENGTH': domain['DATA_LENGTH'],
                'DATA_PRECISION': domain['DATA_PRECISION'],
                'DATA_SCALE': domain['DATA_SCALE'],
                'DEFAULT_VAL': utils.coalesce(domain['DEFAULT_STR'], domain['DEFAULT_NUM'], domain['DEFAULT_DATE']),
                'PADDING': !!domain['PADDING'],
                'ENUMERATED': !!domain['ENUMERATED'],
                'ENUMS': enums.json
            }
            domainsDataToml.push(tomlDomain)
            domainsDataJson.push(jsonDomain)
        }
        return {
            'toml': nullEmptyArray(domainsDataToml),
            'json': domainsDataJson
        }
    }

    async _getDomainEnums(domainRn) {
        let enumsToml = []
        let enumsJson = []
        let query = await this.oci.execute(`
                    select RN,
                           POSITION,
                           VALUE_STR,
                           VALUE_NUM,
                           VALUE_DATE
                      from DMSENUMVALUES T
                     where PRN = :PRN
                     order by POSITION`,
            [domainRn])
        for (let i = 0; i < query.rows.length; i++) {
            let enumRow = query.rows[i]
            let enumName = await this._getResources(enumRow['RN'], 'DMSENUMVALUES', 'NAME')
            enumsToml.push({
                'Позиция': enumRow['POSITION'].trim(),
                'Значение': utils.coalesce(enumRow['VALUE_STR'], enumRow['VALUE_NUM'], enumRow['VALUE_DATE']),
                'Наименование (RU)': enumName.RU,
                'Наименование (UK)': enumName.UK
            })
            enumsJson.push({
                'POSITION': enumRow['POSITION'].trim(),
                'VALUE': utils.coalesce(enumRow['VALUE_STR'], enumRow['VALUE_NUM'], enumRow['VALUE_DATE']),
                'NAME': enumName
            })
        }
        return {
            'toml': nullEmptyArray(enumsToml),
            'json': enumsJson
        }

    }

    async _getMetadataDomainList() {
        let query = await this.oci.execute(`
                select CODE
                  from DMSDOMAINS
                 where RN in (select DOMAIN
                                from DMSCLATTRS
                               where PRN = :CLASSRN
                              union
                              select DOMAIN
                                from DMSCLACTIONSPRM T, UNITFUNC F
                               where F.PRN = :CLASSRN
                                 and T.PRN = F.RN
                              union
                              select DOMAIN
                                from DMSCLMETPARMS T, DMSCLMETHODS M
                               where M.PRN = :CLASSRN
                                 and T.PRN = M.RN
                              union
                              select DOMAIN
                                from DMSCLVIEWSPARAMS T, DMSCLVIEWS V
                               where V.PRN = :CLASSRN
                                 and T.PRN = V.RN)`,
            [this.classRn]
        )
        this._getMessage(this.R.metaDomains)
        // utils.conE(`${this.R.procClass} ${this.classCode}${this.className}…`)
        return query.rows.map((row) => {
            return row['CODE']
        })
    }

    _getMessage(m) {
        // utils.conU(`${m} for ${this.classCode}${this.className}`)
    }

    async _getConditionDomainList() {
        let query = await this.oci.execute(`
                select settings as SETTINGS
                  from UNIT_SHOWMETHODS
                 where PRN = :CLASSRN
                   and LENGTH(SETTINGS) > 0`,
            [this.classRn])
        this._getMessage(this.R.condDomains)
        let domains = []
        for (let i = 0; i < query.rows.length; i++) {
            let doc = new Dom().parseFromString(query.rows[i]['SETTINGS'])
            let nodes = xpath.select('/ShowMethod/Group/DataSource/Params/ConditionParams/Param/@Domain', doc)
            let nodeVals = nodes.map((node) => {
                return node.value
            })
            domains = domains.concat(nodeVals)
        }
        return domains
    }

    async _getClassMeta() {
        let classQuery = await this.oci.execute(`
             select CL.*,
                    (select I.CODE from SYSIMAGES I where I.RN = CL.SYSIMAGE) as SSYSIMAGE,
                    UA.CODE as SDOCFORM
               from UNITLIST CL, UAMODULES UA
              where CL.RN = :CLASSRN
                and CL.DOCFORM = UA.RN(+)`,
            [this.classRn])
        this._getMessage(this.R.classDef)
        let classRow = classQuery.rows[0]
        if (classRow['SSYSIMAGE']) {
            await this._saveIcons(this.classDir, classRow['SSYSIMAGE'])
        }
        const promises = await Promise.all([
            this._getResources(classRow['RN'], 'UNITLIST', 'UNITNAME'), // 0
            this._getTableMeta(classRow['TABLE_NAME']),                 // 1
            this._getAttributesMeta(),                                  // 2
            this._getConstraintsMeta(),                                 // 3
            this._getLinksMeta(),                                       // 4
            this._getViewsMeta(),                                       // 5
            this._getShowMethodsMeta(),                                 // 6
            this._getMethodsMeta(),                                     // 7
            this._getActionsMeta(),                                     // 8
            this._getObjectsMeta()                                      // 9
        ])
        let names = promises[0]
        const toml = {
            'Код': classRow['UNITCODE'],
            'Наименование (RU)': names.RU,
            'Наименование (UK)': names.UK,
            'Абстрактный': !!classRow['ABSTRACT'],
            'Буферный': !!classRow['SIGN_BUFFER'],
            'Ведомый': !!classRow['SIGN_DRIVEN'],
            'Ведущий раздел': classRow['HOSTCODE'],
            'Деление': ['Нет деления', 'По версиям', 'По организациям'][classRow['SIGN_SHARE']],
            'Юридические лица': !!classRow['SIGN_JURPERS'],
            'Иерархия': !!classRow['HIERARCHICAL'],
            'Каталоги': !!classRow['SIGN_HIER'],
            'Свойства документов': !!classRow['USE_DOCPROPS'],
            'Присоединенные документы': !!classRow['USE_FILELINKS'],
            'Процедура считывания значений атрибутов': classRow['GET_PROCEDURE'],
            'Форма раздела': classRow['SDOCFORM'],
            'Пиктограмма': classRow['SSYSIMAGE'],
            'Таблица': promises[1].toml,
            'Атрибуты': {
                'Атрибут': promises[2].toml
            },
            'Ограничения': {
                'Ограничение': promises[3].toml
            },
            'Связи': {
                'Связь': promises[4].toml
            },
            'Представления': {
                'Представление': promises[5].toml
            },
            'Методы вызова': {
                'Метод вызова': promises[6].toml
            },
            'Методы': {
                'Метод': promises[7].toml
            },
            'Действия': {
                'Действие': promises[8].toml
            },
            'Объекты': {
                'Объект': promises[9].toml
            }
        }
        const json = {
            'CODE': classRow['UNITCODE'],
            'NAME': names,
            'ABSTRACT': !!classRow['ABSTRACT'],
            'IS_BUFFER': !!classRow['SIGN_BUFFER'],
            'IS_DRIVEN': !!classRow['SIGN_DRIVEN'],
            'HOST_CLASS': classRow['HOSTCODE'],
            'SIGN_SHARE': ['Нет деления', 'По версиям', 'По организациям'][classRow['SIGN_SHARE']],
            'SIGN_JURPERS': !!classRow['SIGN_JURPERS'],
            'HIERARCHICAL': !!classRow['HIERARCHICAL'],
            'SIGN_CATALOGS': !!classRow['SIGN_HIER'],
            'USE_DOCPROPS': !!classRow['USE_DOCPROPS'],
            'USE_FILELINKS': !!classRow['USE_FILELINKS'],
            'GET_ATTRIBS_PROCEDURE': classRow['GET_PROCEDURE'],
            'UA_DOCFORM': classRow['SDOCFORM'],
            'ICON': classRow['SSYSIMAGE'],
            'TABLE': promises[1].json,
            'ATTRIBUTES': promises[2].json,
            'CONSTRAINTS': promises[3].json,
            'LINKS': promises[4].json,
            'VIEWS': promises[5].json,
            'SHOW_METHODS': promises[6].json,
            'METHODS': promises[7].json,
            'ACTIONS': promises[8].json,
            'OBJECTS': promises[9].json
        }
        return {
            'toml': toml,
            'json': json
        }
    }

    async _getFormsMeta(kind, showMethodRn, actionMethod, table, curPath) {

        const formDataName = 'Form.xml'
        const formEventsName = 'Events'
        const condDataName = 'ConditionForm.xml'
        const condEventsName = 'ConditionEvents'

        let formsToml = []
        let formsJson = []
        const sql = `
            select T.RN,
                   T.FORM_CLASS,
                   T.FORM_NAME,
                   T.EVENTS_LANGUAGE,
                   F_USERFORMS_GET_UAMODULE(T.FORM_UAMODULE) as SFORM_UAMODULE,
                   T.FORM_LANGUAGE,
                   T.FORM_ACTIVE,
                   T.LINK_APPS,
                   T.LINK_PRIVS,
                   T.FORM_DATA,
                   T.FORM_EVENTS,
                   T.FORM_DATA_EXT,
                   T.FORM_EVENTS_EXT
              from USERFORMS T
             where FORM_KIND = :A_KIND
               and ${kind === SHOWMETHOD_FORM_KIND ? 'SHOW_METHOD' : 'FORM_ID'} = :A_METHOD
               and REPL_TABLE ${kind === SHOWMETHOD_FORM_KIND ? 'is null' : '= :A_TAB'}
             order by T.FORM_CLASS,
                      T.FORM_LANGUAGE`
        let binds = {
            'A_KIND': kind,
            'A_METHOD': kind === SHOWMETHOD_FORM_KIND ? showMethodRn : actionMethod
        }
        if (kind === ACTION_FORM_KIND) {
            binds['A_TAB'] = table
        }
        const query = await this.oci.execute(sql, binds)
        for (let i = 0; i < query.rows.length; i++) {
            const formRecord = query.rows[i]
            const relPath = path.posix.join(curPath, 'Forms', utils.hashFormName(formRecord['FORM_CLASS']))
            const fullPath = path.posix.join(this.classDir, relPath)
            const eventExt = formRecord['EVENTS_LANGUAGE'] ?
                ['vbs', 'js', 'pas', 'pl', 'py'][formRecord['EVENTS_LANGUAGE']] : 'txt'
            if (formRecord['FORM_DATA']) {
                await utils.saveClob1251Xml(
                    formRecord['FORM_DATA'],
                    fullPath,
                    `${formRecord['FORM_LANGUAGE']}_${formDataName}`
                )
            }
            if (formRecord['FORM_EVENTS']) {
                await utils.saveClob1251(
                    formRecord['FORM_EVENTS'],
                    fullPath,
                    `${formRecord['FORM_LANGUAGE']}_${formEventsName}.${eventExt}`
                )
            }
            if (formRecord['FORM_DATA_EXT']) {
                await utils.saveClob1251Xml(
                    formRecord['FORM_DATA_EXT'],
                    fullPath,
                    `${formRecord['FORM_LANGUAGE']}_${condDataName}`
                )
            }
            if (formRecord['FORM_EVENTS_EXT']) {
                await utils.saveClob1251(
                    formRecord['FORM_EVENTS_EXT'],
                    fullPath,
                    `${formRecord['FORM_LANGUAGE']}_${condEventsName}.${eventExt}`
                )
            }
            const apps = await this._getFormApplications(formRecord['RN'])
            formsToml.push({
                'Имя': formRecord['FORM_CLASS'],
                'Наименование': formRecord['FORM_NAME'],
                'Тип скрипта': formRecord['EVENTS_LANGUAGE'] ?
                    ['VBScript', 'JScript', 'DelphiScript', 'PerlScript', 'PythonScript'][formRecord['EVENTS_LANGUAGE']]
                    : null,
                'Пользовательское приложение (форма)': formRecord['SFORM_UAMODULE'],
                'Национальный язык формы': formRecord['FORM_LANGUAGE'],
                'Доступна для использования': !!formRecord['FORM_ACTIVE'],
                'Учитывать связи с приложениями': !!formRecord['LINK_APPS'],
                'Учитывать назначение пользователям, ролям': !!formRecord['LINK_PRIVS'],
                'Приложения': formRecord['LINK_APPS'] ? {
                    'Приложение': apps.toml
                } : null,
                'Файл': formRecord['FORM_DATA'] ? path.posix.join('.', relPath, `${formRecord['FORM_LANGUAGE']}_${formDataName}`) : null
            })
            formsJson.push({
                'FORM_CLASS': formRecord['FORM_CLASS'],
                'FORM_NAME': formRecord['FORM_NAME'],
                'EVENTS_LANGUAGE': formRecord['EVENTS_LANGUAGE'] ?
                    ['VBScript', 'JScript', 'DelphiScript', 'PerlScript', 'PythonScript'][formRecord['EVENTS_LANGUAGE']]
                    : null,
                'FORM_UAMODULE': formRecord['SFORM_UAMODULE'],
                'FORM_LANGUAGE': formRecord['FORM_LANGUAGE'],
                'FORM_ACTIVE': !!formRecord['FORM_ACTIVE'],
                'LINK_APPS': !!formRecord['LINK_APPS'],
                'LINK_PRIVS': !!formRecord['LINK_PRIVS'],
                'LINKED_APPS': apps.json,
                'FILE': formRecord['FORM_DATA'] ? path.posix.join('.', relPath, `${formRecord['FORM_LANGUAGE']}_${formDataName}`) : null
            })
        }
        return {
            'toml': nullEmptyArray(formsToml),
            'json': formsJson
        }
    }

    async _getTableMeta(tableName) {
        if (tableName) {
            const query = await this.oci.execute(
                'select TL.* from TABLELIST TL where TL.TABLENAME = :TABLENAME',
                [tableName])
            this._getMessage(this.R.tabDef)
            const res = query.rows[0]
            const names = await this._getResources(res['RN'], 'TABLELIST', 'TABLENOTE')
            const cToml = {
                'Имя': res['TABLENAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип информации': ['Постоянная', 'Временная'][res['TEMPFLAG']],
                'Технология производства': ['Стандарт', 'Конструктор'][res['TECHNOLOGY']]
            }
            const cJson = {
                'TABLENAME': res['TABLENAME'],
                'COMMENT': names,
                'TEMPFLAG': !!res['TEMPFLAG'],
                'TECHNOLOGY': ['Стандарт', 'Конструктор'][res['TECHNOLOGY']]
            }
            return {
                'toml': cToml,
                'json': cJson
            }
        }
        else return {
            'toml': null,
            'json': null
        }
    }

    async _getAttributesMeta() {
        const attrsQuery = await this.oci.execute(`
                select CA.*,
                       DM.CODE            as SDOMAIN,
                       CL.CONSTRAINT_NAME as SREF_LINK,
                       CAR.COLUMN_NAME    as SREF_ATTRIBUTE
                  from DMSCLATTRS CA, DMSDOMAINS DM, DMSCLLINKS CL, DMSCLATTRS CAR
                 where CA.PRN = :CLASSRN
                   and CA.DOMAIN = DM.RN
                   and CA.REF_LINK = CL.RN(+)
                   and CA.REF_ATTRIBUTE = CAR.RN(+)
                 order by CA.COLUMN_NAME`,
            [this.classRn])
        this._getMessage(this.R.attrMeta)
        let attrsToml = []
        let attrsJson = []
        for (let i = 0, len = attrsQuery.rows.length; i < len; i++) {
            const attr = attrsQuery.rows[i]
            const names = await this._getResources(attr['RN'], 'DMSCLATTRS', 'CAPTION')
            attrsToml.push({
                'Имя': attr['COLUMN_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Позиция': attr['POSITION'],
                'Тип': ['Физический', 'Логический', 'Получен по связи'][attr['KIND']],
                'Домен': attr['SDOMAIN'],
                'Связь': attr['SREF_LINK'],
                'Атрибут связи': attr['SREF_ATTRIBUTE']
            })
            attrsJson.push({
                'COLUMN_NAME': attr['COLUMN_NAME'],
                'CAPTION': names,
                'POSITION': attr['POSITION'],
                'KIND': ['Физический', 'Логический', 'Получен по связи'][attr['KIND']],
                'DOMAIN': attr['SDOMAIN'],
                'REF_LINK': attr['SREF_LINK'],
                'REF_ATTRIBUTE': attr['SREF_ATTRIBUTE']
            })
        }
        return {
            'toml': nullEmptyArray(attrsToml),
            'json': attrsJson
        }
    }

    async _getConstraintsMeta() {
        const CONSTRAINT_TYPES = {
            0: 'Уникальность',
            1: 'Первичный ключ',
            2: 'Проверка',
            5: 'Обязательность',
            6: 'Неизменяемость'
        }
        const query = await this.oci.execute(`
                select T.*,
                       MES.CODE       as MES_CODE,
                       MES.TECHNOLOGY as MES_TECHNOLOGY,
                       MES.KIND       as MES_KIND
                  from DMSCLCONSTRS T, DMSMESSAGES MES
                 where T.PRN = :CLASSRN
                   and T.MESSAGE = MES.RN(+)
                 order by T.CONSTRAINT_TYPE, T.CONSTRAINT_NAME
            `, [this.classRn])
        this._getMessage(this.R.consMeta)
        let constrsToml = []
        let constrsJson = []
        for (let i = 0, len = query.rows.length; i < len; i++) {
            const constr = query.rows[i]
            const names = await this._getResources(constr['RN'], 'DMSCLCONSTRS', 'CONSTRAINT_NOTE')
            const messages = await this._getResources(constr['MESSAGE'], 'DMSMESSAGES', 'TEXT')
            const attrs = await this._getConstraintAttributesMeta(constr['RN'])
            constrsToml.push({
                'Имя': constr['CONSTRAINT_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип': CONSTRAINT_TYPES[constr['CONSTRAINT_TYPE']],
                'Использовать для разрешения ссылок': !!constr['LINKS_SIGN'],
                'Текст ограничения': constr['CONSTRAINT_TEXT'],
                'Сообщение при нарушениии': {
                    'Мнемокод': constr['MES_CODE'],
                    'Технология производства': ['Стандарт', 'Конструктор'][constr['MES_TECHNOLOGY']],
                    'Тип': ['Сообщение ограничения', 'Сообщение исключения'][constr['MES_KIND']],
                    'Текст (RU)': messages.RU,
                    'Текст (UK)': messages.UK
                },
                'Атрибуты': {
                    'Атрибут': attrs.toml
                }
            })
            constrsJson.push({
                'CONSTRAINT_NAME': constr['CONSTRAINT_NAME'],
                'COMMENT': names,
                'CONSTRAINT_TYPE': CONSTRAINT_TYPES[constr['CONSTRAINT_TYPE']],
                'USE_TO_JOIN': !!constr['LINKS_SIGN'],
                'CONSTRAINT_TEXT': constr['CONSTRAINT_TEXT'],
                'MESSAGE': {
                    'CODE': constr['MES_CODE'],
                    'TECHNOLOGY': ['Стандарт', 'Конструктор'][constr['MES_TECHNOLOGY']],
                    'KIND': ['Сообщение ограничения', 'Сообщение исключения'][constr['MES_KIND']],
                    'TEXT': messages
                },
                'ATTRIBUTES': attrs.json
            })
        }
        return {
            'toml': nullEmptyArray(constrsToml),
            'json': constrsJson
        }
    }

    async _getConstraintAttributesMeta(constrRn) {
        let query = await this.oci.execute(`
                        select T.POSITION, TR1.COLUMN_NAME
                          from DMSCLCONATTRS T, DMSCLATTRS TR1
                         where T.PRN = :A_CONS
                           and T.ATTRIBUTE = TR1.RN
                         order by TR1.COLUMN_NAME
                     `, [constrRn])
        const atToml = query.rows.map((attr) => {
            return {
                'Позиция': attr['POSITION'],
                'Атрибут': attr['COLUMN_NAME']
            }
        })
        const atJson = query.rows.map((attr) => {
            return {
                'POSITION': attr['POSITION'],
                'COLUMN_NAME': attr['COLUMN_NAME']
            }
        })
        return {
            'toml': nullEmptyArray(atToml),
            'json': atJson
        }
    }

    async _getLinksMeta() {
        let linksToml = []
        let linksJson = []
        const query = await this.oci.execute(`
                select T.RN,
                       T.CONSTRAINT_NAME,
                       US.UNITCODE,
                       ST.CODE            as SSTEREOTYPE,
                                T.FOREIGN_KEY,
                       CC.CONSTRAINT_NAME as SSRC_CONSTRAINT,
                       T.RULE,
                       L.CONSTRAINT_NAME  as SMASTER_LINK,
                       M1.CODE            as SMESSAGE1,
                       M2.CODE            as SMESSAGE2,
                       LA.COLUMN_NAME     as SLEVEL_ATTR,
                       PA.COLUMN_NAME     as SPATH_ATTR
                  from DMSCLLINKS   T,
                       UNITLIST     US,
                       DMSLSTYPES   ST,
                       DMSCLCONSTRS CC,
                       DMSCLLINKS   L,
                       DMSMESSAGES  M1,
                       DMSMESSAGES  M2,
                       DMSCLATTRS   LA,
                       DMSCLATTRS   PA
                 where T.DESTINATION = :WORKIN_CLASS
                   and T.SOURCE = US.RN
                   and T.STEREOTYPE = ST.RN(+)
                   and T.SRC_CONSTRAINT = CC.RN(+)
                   and T.MASTER_LINK = L.RN(+)
                   and T.MESSAGE1 = M1.RN(+)
                   and T.MESSAGE2 = M2.RN(+)
                   and T.LEVEL_ATTR = LA.RN(+)
                   and T.PATH_ATTR = PA.RN(+)
                 order by T.CONSTRAINT_NAME`,
            [this.classRn])
        this._getMessage(this.R.linkMeta)
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const link = query.rows[i]
            const names = await this._getResources(link['RN'], 'DMSCLLINKS', 'CONSTRAINT_NOTE')
            const attrs = await this._getLinkAttributesMeta(link['RN'])
            linksToml.push({
                'Код': link['CONSTRAINT_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Класс-источник': link['UNITCODE'],
                'Стереотип': link['SSTEREOTYPE'],
                'Физическая связь': !!link['FOREIGN_KEY'],
                'Ограничение класса-источника': link['SSRC_CONSTRAINT'],
                'Правило': ['Нет правил', 'Каскадное удаление'][link['RULE']],
                'Мастер-связь': link['SMASTER_LINK'],
                'Сообщение при нарушениии cо стороны источника': link['SMESSAGE1'],
                'Сообщение при нарушениии cо стороны приемника': link['SMESSAGE2'],
                'Атрибут уровня иерархии': link['SLEVEL_ATTR'],
                'Атрибут полного имени иерархии': link['SPATH_ATTR'],
                'Атрибуты': {
                    'Атрибут': attrs.toml
                }
            })
            linksJson.push({
                'CONSTRAINT_NAME': link['CONSTRAINT_NAME'],
                'CONSTRAINT_NOTE': names,
                'UNIT_SOURCE': link['UNITCODE'],
                'STEREOTYPE': link['SSTEREOTYPE'],
                'FOREIGN_KEY': !!link['FOREIGN_KEY'],
                'SRC_CONSTRAINT': link['SSRC_CONSTRAINT'],
                'RULE': ['Нет правил', 'Каскадное удаление'][link['RULE']],
                'MASTER_LINK': link['SMASTER_LINK'],
                'MESSAGE_SRC': link['SMESSAGE1'],
                'MESSAGE_DEST': link['SMESSAGE2'],
                'HIER_LEVEL_ATTR': link['SLEVEL_ATTR'],
                'HIER_PATH_ATTR': link['SPATH_ATTR'],
                'ATTRIBUTES': attrs.json
            })
        }
        return {
            'toml': nullEmptyArray(linksToml),
            'json': linksJson
        }
    }

    async _getLinkAttributesMeta(linkRn) {
        let attrsToml = []
        let attrsJson = []
        const query = await this.oci.execute(`
                        select T.POSITION,
                               TR1.COLUMN_NAME as SSOURCE,
                               TR2.COLUMN_NAME as SDESTINATION
                          from DMSCLLINKATTRS T,
                               DMSCLATTRS     TR1,
                               DMSCLATTRS     TR2
                         where T.PRN = :A_LINK
                           and T.SOURCE = TR1.RN
                           and T.DESTINATION = TR2.RN
                         order by T.POSITION`,
            [linkRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const attr = query.rows[i]
            attrsToml.push({
                'Позиция': attr['POSITION'],
                'Атрибут класса-приемника': attr['SDESTINATION'],
                'Атрибут класса-источника': attr['SSOURCE']
            })
            attrsJson.push({
                'POSITION': attr['POSITION'],
                'DESTINATION': attr['SDESTINATION'],
                'SOURCE': attr['SSOURCE']
            })
        }
        return {
            'toml': nullEmptyArray(attrsToml),
            'json': attrsJson
        }
    }

    async _getViewsMeta() {
        let viewsToml = []
        let viewsJson = []
        const query = await this.oci.execute(`
                select T.RN,
                       T.VIEW_NAME,
                       T.CUSTOM_QUERY,
                       T.ACCESSIBILITY,
                       T.QUERY_SQL
                  from DMSCLVIEWS T
                 where T.PRN = :WORKIN_CLASS
                 order by T.VIEW_NAME`,
            [this.classRn])
        this._getMessage(this.R.viewMeta)
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const view = query.rows[i]
            const names = await this._getResources(view['RN'], 'DMSCLVIEWS', 'VIEW_NOTE')
            const params = await this._getViewParamsMeta(view['RN'])
            const attrs = await this._getViewAttributesMeta(view['RN'])
            viewsToml.push({
                'Имя': view['VIEW_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип': ['Представление', 'Запрос'][view['CUSTOM_QUERY']],
                'Вызывается с клиента': !!view['ACCESSIBILITY'],
                'Текст запроса': view['QUERY_SQL'],
                'Параметры': {
                    'Параметр': view['CUSTOM_QUERY'] ? params.toml : null
                },
                'Атрибуты': {
                    'Атрибут': attrs.toml
                }
            })
            viewsJson.push({
                'VIEW_NAME': view['VIEW_NAME'],
                'VIEW_NOTE': names,
                'CUSTOM_QUERY': !!view['CUSTOM_QUERY'],
                'PUBLIC': !!view['ACCESSIBILITY'],
                'QUERY_SQL': view['QUERY_SQL'],
                'QUERY_PARAMS': params.json,
                'ATTRIBUTES': attrs.json
            })
        }
        return {
            'toml': nullEmptyArray(viewsToml),
            'json': viewsJson
        }
    }

    async _getViewParamsMeta(viewRn) {
        let paramsToml = []
        let paramsJson = []
        const paramsQuery = await this.oci.execute(`
                        select T.PARAM_NAME,
                               D.CODE as SDOMAIN
                          from DMSCLVIEWSPARAMS T,
                               DMSDOMAINS       D
                         where T.PRN = :A_VIEW
                           and T.DOMAIN = D.RN
                         order by T.PARAM_NAME`,
            [viewRn])
        for (let i = 0, l = paramsQuery.rows.length; i < l; i++) {
            const param = paramsQuery.rows[i]
            paramsToml.push({
                'Наименование параметра': param['PARAM_NAME'],
                'Домен': param['SDOMAIN']
            })
            paramsJson.push({
                'PARAM_NAME': param['PARAM_NAME'],
                'DOMAIN': param['SDOMAIN']
            })
        }
        return {
            'toml': nullEmptyArray(paramsToml),
            'json': paramsJson
        }
    }

    async _getViewAttributesMeta(viewRn) {
        let attrsToml = []
        let attrsJson = []
        const query = await this.oci.execute(`
                        select A.POSITION,
                               A.COLUMN_NAME as SATTR,
                               T.COLUMN_NAME
                          from DMSCLVIEWSATTRS T,
                               DMSCLATTRS      A
                         where T.PRN = :A_VIEW
                           and T.ATTR = A.RN
                         order by A.COLUMN_NAME`,
            [viewRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const attr = query.rows[i]
            attrsToml.push({
                'Атрибут класса': attr['SATTR'],
                'Имя колонки': attr['COLUMN_NAME']
            })
            attrsJson.push({
                'CLASS_ATTRIBUTE': attr['SATTR'],
                'COLUMN_NAME': attr['COLUMN_NAME']
            })
        }
        return {
            'toml': nullEmptyArray(attrsToml),
            'json': attrsJson
        }
    }

    async _getMethodsMeta() {
        let methodsToml = []
        let methodsJson = []
        const q = await this.oci.execute(`
                select T.RN,
                       T.CODE,
                       T.METHOD_TYPE,
                       T.ACCESSIBILITY,
                       T.PACKAGE,
                       T.NAME,
                       (select D.CODE
                          from DMSCLMETPARMS P,
                               DMSDOMAINS    D
                         where P.DOMAIN = D.RN
                           and P.PRN = T.RN
                           and P.NAME = 'RESULT'
                           and T.METHOD_TYPE = 1) as SRESULT_DOMAIN
                  from DMSCLMETHODS T
                 where T.PRN = :WORKIN_CLASS
                 order by T.CODE`,
            [this.classRn])
        this._getMessage(this.R.metMeta)
        for (let i = 0, l = q.rows.length; i < l; i++) {
            const method = q.rows[i]
            const names = await
                this._getResources(method['RN'], 'DMSCLMETHODS', 'NOTE')
            const comments = await
                this._getResources(method['RN'], 'DMSCLMETHODS', 'COMMENT')
            const params = await this._getMethodParamsMeta(method['RN'])
            methodsToml.push({
                'Мнемокод': method['CODE'],
                'Тип метода': ['Процедура', 'Функция'][method['METHOD_TYPE']],
                'Доступность': ['Базовый', 'Клиентский'][method['ACCESSIBILITY']],
                'Пакет': method['PACKAGE'],
                'Процедура/функция': method['NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Примечание (RU)': comments.RU,
                'Примечание (UK)': comments.UK,
                'Домен результата функции': method['SRESULT_DOMAIN'],
                'Параметры': {
                    'Параметр': params.toml
                }
            })
            methodsJson.push({
                'CODE': method['CODE'],
                'METHOD_TYPE': ['Процедура', 'Функция'][method['METHOD_TYPE']],
                'ACCESSIBILITY': ['Базовый', 'Клиентский'][method['ACCESSIBILITY']],
                'PACKAGE': method['PACKAGE'],
                'PROC_NAME': method['NAME'],
                'NAME': names,
                'COMMENT': comments,
                'RESULT_DOMAIN': method['SRESULT_DOMAIN'],
                'PARAMS': params.json
            })
        }
        return {
            'toml': nullEmptyArray(methodsToml),
            'json': methodsJson
        }
    }

    async _getMethodParamsMeta(methodRn) {
        let paramsToml = []
        let paramsJson = []
        const query = await this.oci.execute(`
                    select T.RN,
                           T.POSITION,
                           T.NAME,
                           T.INOUT,
                           D.CODE         as SDOMAIN,
                           T.LINK_TYPE,
                           A.COLUMN_NAME,
                           T.DEF_NUMBER,
                           T.CONTEXT,
                           T.DEF_STRING,
                           T.DEF_DATE,
                           F.CODE         as LINKED_FUNCTION,
                           T.ACTION_PARAM,
                           T.MANDATORY
                      from DMSCLMETPARMS T,
                           DMSDOMAINS    D,
                           DMSCLATTRS    A,
                           DMSCLMETHODS  F
                     where T.PRN = :A_METHOD
                       and T.DOMAIN = D.RN
                       and T.LINK_ATTR = A.RN(+)
                       and T.LINKED_FUNCTION = F.RN(+)
                     order by T.NAME`,
            [methodRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const param = query.rows[i]
            const names = await this._getResources(param['RN'], 'DMSCLMETPARMS', 'NOTE')
            paramsToml.push({
                'Имя': param['NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Позиция': param['POSITION'],
                'Тип': ['Входной/выходной (in/out)', 'Входной (in)', 'Выходной (out)'][param['INOUT']],
                'Домен': param['SDOMAIN'],
                'Тип привязки': [
                    'Нет',
                    'Атрибут',
                    'Контекст',
                    'Значение',
                    'Результат функции',
                    'Параметр действия'
                ][param['LINK_TYPE']],
                'Атрибут': param['COLUMN_NAME'],
                'Значение': (param['DEF_NUMBER'] || param['DEF_STRING'] || param['DEF_DATE']) ?
                    utils.coalesce(param['DEF_NUMBER'], param['DEF_STRING'], param['DEF_DATE']) : null,
                'Контекст': param['CONTEXT'] !== null ? CONTEXTS[param['CONTEXT']] : null,
                'Функция': param['LINKED_FUNCTION'],
                'Параметр действия': param['ACTION_PARAM'],
                'Обязательный для заполнения': !!param['MANDATORY']
            })
            paramsJson.push({
                'NAME': param['NAME'],
                'CAPTION': names,
                'POSITION': param['POSITION'],
                'INOUT': ['Входной/выходной (in/out)', 'Входной (in)', 'Выходной (out)'][param['INOUT']],
                'DOMAIN': param['SDOMAIN'],
                'LINK_TYPE': [
                    'Нет',
                    'Атрибут',
                    'Контекст',
                    'Значение',
                    'Результат функции',
                    'Параметр действия'
                ][param['LINK_TYPE']],
                'ATTRIBUTE': param['COLUMN_NAME'],
                'VALUE': (param['DEF_NUMBER'] || param['DEF_STRING'] || param['DEF_DATE']) ?
                    utils.coalesce(param['DEF_NUMBER'], param['DEF_STRING'], param['DEF_DATE']) : null,
                'CONTEXT': param['CONTEXT'] !== null ? CONTEXTS[param['CONTEXT']] : null,
                'LINKED_FUNCTION': param['LINKED_FUNCTION'],
                'ACTION_PARAM': param['ACTION_PARAM'],
                'MANDATORY': !!param['MANDATORY']
            })
        }
        return {
            'toml': nullEmptyArray(paramsToml),
            'json': paramsJson
        }
    }

    async _getShowMethodsMeta() {
        const settingsFileName = 'Settings.xml'
        let showMethodsToml = []
        let showMethodsJson = []
        const query = await this.oci.execute(`
                  select SM.RN,
                         SM.METHOD_CODE,
                         SM.TECHNOLOGY,
                         (select I.CODE
                            from SYSIMAGES I
                           where I.RN = SM.SYSIMAGE) as SSYSIMAGE,
                         SM.COND_TYPE,
                         SM.USEFORVIEW,
                         SM.USEFORLINKS,
                         SM.USEFORDICT,
                         SM.SETTINGS
                    from UNIT_SHOWMETHODS SM
                   where SM.PRN = :WORKIN_CLASS
                          order by SM.TECHNOLOGY,
                     SM.METHOD_CODE`,
            [this.classRn])
        this._getMessage(this.R.shMetMeta)
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const showMethod = query.rows[i]
            const names = await this._getResources(showMethod['RN'], 'UNIT_SHOWMETHODS', 'METHOD_NAME')
            const relpath = path.posix.join('ShowMethods', showMethod['METHOD_CODE'])
            if (showMethod['SSYSIMAGE']) {
                await this._saveIcons(path.posix.join(this.classDir, relpath), showMethod['SSYSIMAGE'])
            }
            if (showMethod['SETTINGS']) {
                await utils.saveClob1251Xml(showMethod['SETTINGS'], path.posix.join(this.classDir, relpath), settingsFileName)
            }
            const params = await this._getShowMethodParamsMeta(showMethod['RN'])
            const forms = await this._getFormsMeta(SHOWMETHOD_FORM_KIND, showMethod['RN'], null, null, relpath)
            showMethodsToml.push({
                'Мнемокод': showMethod['METHOD_CODE'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Технология производства': ['Стандарт', 'Конструктор'][showMethod['TECHNOLOGY']],
                'Пиктограмма': showMethod['SSYSIMAGE'],
                'Тип условий отбора': ['Клиент', 'Сервер'][showMethod['COND_TYPE']],
                'Использовать для отображения по умолчанию': !!showMethod['USEFORVIEW'],
                'Использовать для отображения через связи документов': !!showMethod['USEFORLINKS'],
                'Использовать для отображения в качестве словаря': !!showMethod['USEFORDICT'],
                'Настройка': showMethod['SETTINGS'] ? path.posix.join('.', relpath, settingsFileName) : null,
                'Параметры': {
                    'Параметр': params.toml
                },
                'Формы': {
                    'Форма': forms.toml
                }
            })
            showMethodsJson.push({
                'METHOD_CODE': showMethod['METHOD_CODE'],
                'METHOD_NAME': names,
                'TECHNOLOGY': ['Стандарт', 'Конструктор'][showMethod['TECHNOLOGY']],
                'ICON': showMethod['SSYSIMAGE'],
                'CONDITIONS_TYPE': ['Клиент', 'Сервер'][showMethod['COND_TYPE']],
                'USE_FOR_VIEW': !!showMethod['USEFORVIEW'],
                'USE_FOR_LINKS': !!showMethod['USEFORLINKS'],
                'USE_FOR_DICT': !!showMethod['USEFORDICT'],
                'SETTINGS': showMethod['SETTINGS'] ? path.posix.join('.', relpath, settingsFileName) : null,
                'PARAMS': params.json,
                'FORMS': forms.json
            })
        }
        return {
            'toml': nullEmptyArray(showMethodsToml),
            'json': showMethodsJson
        }
    }

    async _getShowMethodParamsMeta(showMethodRn) {
        let paramsToml = []
        let paramsJson = []
        const query = await this.oci.execute(`
                    select MP.RN,
                           CA.COLUMN_NAME,
                           MP.IN_CODE,
                           MP.OUT_CODE,
                           MP.DATA_TYPE,
                           MP.DIRECT_SQL,
                           MP.BACK_SQL
                      from UNITPARAMS MP,
                           DMSCLATTRS CA
                     where MP.PARENT_METHOD = :A_METHOD
                       and MP.ATTRIBUTE = CA.RN(+)
                     order by MP.TECHNOLOGY,
                              MP.IN_CODE,
                              MP.OUT_CODE`,
            [showMethodRn])
        for (let i = 0; i < query.rows.length; i++) {
            const param = query.rows[i]
            const names = await this._getResources(param['RN'], 'UNITPARAMS', 'PARAMNAME')
            paramsToml.push({
                'Атрибут класса': param['COLUMN_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Имя входного параметра': param['IN_CODE'],
                'Имя выходного параметра': param['OUT_CODE'],
                'Тип данных': ['Строка', 'Дата', 'Число'][param['DATA_TYPE']],
                'Прямой запрос': param['DIRECT_SQL'],
                'Обратный запрос': param['BACK_SQL']
            })
            paramsJson.push({
                'COLUMN_NAME': param['COLUMN_NAME'],
                'NAME': names,
                'IN_CODE': param['IN_CODE'],
                'OUT_CODE': param['OUT_CODE'],
                'DATA_TYPE': ['Строка', 'Дата', 'Число'][param['DATA_TYPE']],
                'DIRECT_SQL': param['DIRECT_SQL'],
                'BACK_SQL': param['BACK_SQL']
            })
        }
        return {
            'toml': nullEmptyArray(paramsToml),
            'json': paramsJson
        }
    }

    async _getFormApplications(formRn) {
        let appsToml = []
        let appsJson = []
        const query = await this.oci.execute(`
                        select FLA.APPCODE
                          from USERFORMLNKAPPS FLA
                         where FLA.PRN = :A_FORM_RN
                         order by FLA.APPCODE`,
            [formRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            appsToml.push({
                'Код': query.rows[i]['APPCODE']
            })
            appsJson.push({
                'APPCODE': query.rows[i]['APPCODE']
            })
        }
        return {
            'toml': nullEmptyArray(appsToml),
            'json': appsJson
        }
    }

    async _getActionsMeta() {
        const ACTION_STANDARDS = {
            0: 'Нестандартное',
            1: 'Cтандартное добавление/размножение',
            2: 'Cтандартное исправление',
            3: 'Cтандартное удаление',
            4: 'Cтандартное перемещение (в каталог)',
            5: 'Cтандартное перемещение (из каталога)',
            6: 'Стандартное перемещение (в иерархии)',
            7: 'Заполнение на основе данных раздела',
            8: 'Стандартный перенос в Excel',
            9: 'Стандартный экспорт',
            10: 'Стандартный просмотр спецификации',
            11: 'Открыть раздел',
            12: 'Стандартное формирование ЭЦП',
            13: 'Стандартная проверка ЭЦП',
            14: 'Стандартное удаление ЭЦП',
            15: 'Стандартный файловый экспорт',
            16: 'Стандартный файловый импорт',
            17: 'Стандартное ослабление контроля связей',
            18: 'Стандартное восстановление контроля связей',
            30: 'Пользовательский отчет',
            31: 'Пользовательское приложение'
        }
        const OVERRIDES = {
            0: 'Нестандартное',
            1: 'Cтандартное добавление/размножение',
            2: 'Cтандартное исправление',
            3: 'Cтандартное удаление',
            4: 'Cтандартное перемещение (в каталог)',
            5: 'Cтандартное перемещение (из каталога)',
            6: 'Стандартное перемещение (в иерархии)',
            7: 'Заполнение на основе данных раздела',
            8: 'Стандартный перенос в Excel',
            9: 'Стандартный экспорт',
            10: 'Стандартный просмотр спецификации',
            11: 'Открыть раздел',
            12: 'Стандартное формирование ЭЦП',
            13: 'Стандартная проверка ЭЦП',
            14: 'Стандартное удаление ЭЦП',
            15: 'Стандартный файловый экспорт',
            16: 'Стандартный файловый импорт'
        }
        let actionsToml = []
        let actionsJson = []
        const query = await this.oci.execute(`
               select UF.RN,
                    UF.STANDARD,
                    UF.DETAILCODE,
                    UF.CODE,
                    UF.TECHNOLOGY,
                    UF.NUMB,
                    M.CODE as SMETHOD,
                    (select I.CODE
                       from SYSIMAGES I
                      where I.RN = UF.SYSIMAGE) as SSYSIMAGE,
                    UF.PROCESS_MODE,
                    UF.TRANSACT_MODE,
                    UF.REFRESH_MODE,
                    UF.SHOW_DIALOG,
                    UF.ONLY_CUSTOM_MODE,
                    UF.OVERRIDE,
                    UF.UNCOND_ACCESS
               from UNITFUNC     UF,
                    DMSCLMETHODS M
              where UF.PRN = :WORKIN_CLASS
                and UF.METHOD = M.RN(+)
              order by UF.CODE`,
            [this.classRn])
        this._getMessage(this.R.actMeta)
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const action = query.rows[i]
            const curPath = path.posix.join('Actions', action['CODE'])
            if (action['SSYSIMAGE']) {
                await this._saveIcons(path.posix.join(this.classDir, curPath), action['SSYSIMAGE'])
            }
            const names = await this._getResources(action['RN'], 'UNITFUNC', 'NAME')
            const forms = await this._getFormsMeta(ACTION_FORM_KIND, null, action['RN'], 'UNITFUNC', curPath)
            const params = await this._getActionParamsMeta(action['RN'])
            const methods = await this._getActionMethodsMeta(action['RN'], curPath)
            const steps = await this._getActionStepsMeta(action['RN'], curPath)
            actionsToml.push({
                'Тип': ACTION_STANDARDS[action['STANDARD']],
                'Подчиненный класс': action['DETAILCODE'],
                'Код': action['CODE'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Технология производства': ['Стандарт', 'Конструктор'][action['TECHNOLOGY']],
                'Позиция': action['NUMB'],
                'Реализующий метод': action['SMETHOD'],
                'Пиктограмма': action['SSYSIMAGE'],
                'Обработка записей': [
                    'Не зависит от записей',
                    'Для одной текущей записи',
                    'Для всех помеченных записей'
                ][action['PROCESS_MODE']],
                'Завершение транзакции': [
                    'После всех вызовов действия', '' +
                    'После каждого вызова действия'
                ][action['TRANSACT_MODE']],
                'Обновление выборки': [
                    'Не обновлять',
                    'Обновлять только текущую запись',
                    'Обновлять всю выборку'
                ][action['REFRESH_MODE']],
                'Показывать диалог при отсутствии визуализируемых параметров': !!action['SHOW_DIALOG'],
                'Отображать только при технологии производства «Конструктор»': !!action['ONLY_CUSTOM_MODE'],
                'Переопределенный тип': OVERRIDES[action['OVERRIDE']],
                'Безусловная доступность': !!action['UNCOND_ACCESS'],
                'Формы': {
                    'Форма': forms.toml
                },
                'Параметры': {
                    'Параметр': params.toml
                },
                'Методы': {
                    'Метод': methods.toml
                },
                'Шаги': {
                    'Шаг': steps.toml
                }
            })
            actionsJson.push({
                'CODE': action['CODE'],
                'ACTION_STANDARD': ACTION_STANDARDS[action['STANDARD']],
                'DETAILCODE': action['DETAILCODE'],
                'NAME': names,
                'TECHNOLOGY': ['Стандарт', 'Конструктор'][action['TECHNOLOGY']],
                'NUMB': action['NUMB'],
                'CLASS_METHOD': action['SMETHOD'],
                'ICON': action['SSYSIMAGE'],
                'PROCESS_MODE': [
                    'Не зависит от записей',
                    'Для одной текущей записи',
                    'Для всех помеченных записей'
                ][action['PROCESS_MODE']],
                'TRANSACT_MODE': [
                    'После всех вызовов действия', '' +
                    'После каждого вызова действия'
                ][action['TRANSACT_MODE']],
                'REFRESH_MODE': [
                    'Не обновлять',
                    'Обновлять только текущую запись',
                    'Обновлять всю выборку'
                ][action['REFRESH_MODE']],
                'FORCE_SHOW_DIALOG': !!action['SHOW_DIALOG'],
                'ONLY_CUSTOM_MODE': !!action['ONLY_CUSTOM_MODE'],
                'OVERRIDE': OVERRIDES[action['OVERRIDE']],
                'UNCOND_ACCESS': !!action['UNCOND_ACCESS'],
                'FORMS': forms.json,
                'PARAMS': params.json,
                'METHODS': methods.json,
                'STEPS': steps.json
            })
        }
        return {
            'toml': nullEmptyArray(actionsToml),
            'json': actionsJson
        }
    }

    async _getActionParamsMeta(actionRn) {
        let paramsToml = []
        let paramsJson = []
        const query = await this.oci.execute(`
            select T.RN,
                   T.NAME,
                   T.POSITION,
                   D.CODE        as SDOMAIN,
                   T.LINK_TYPE,
                   A.COLUMN_NAME as SLINK_ATTR,
                   T.CONTEXT,
                   T.DEF_NUMBER,
                   T.DEF_STRING,
                   T.DEF_DATE,
                   F.CODE        as SLINKED_FUNCTION,
                   T.SM_PARAM
              from DMSCLACTIONSPRM T,
                   DMSDOMAINS      D,
                   DMSCLATTRS      A,
                   DMSCLMETHODS    F
             where T.PRN = :A_ACTION
               and T.DOMAIN = D.RN
               and T.LINK_ATTR = A.RN(+)
               and T.LINKED_FUNCTION = F.RN(+)
             order by T.NAME`,
            [actionRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const param = query.rows[i]
            paramsToml.push({
                'Имя': param['NAME'],
                'Позиция': param['POSITION'],
                'Домен': param['SDOMAIN'],
                'Тип привязки': [
                    'Нет',
                    'Атрибут',
                    'Контекст',
                    'Значение',
                    'Результат функции',
                    'Параметр метода вызова'
                ][param['LINK_TYPE']],
                'Атрибут': param['SLINK_ATTR'],
                'Контекст': param['CONTEXT'] !== null ? CONTEXTS[param['CONTEXT']] : null,
                'Значение': (param['DEF_NUMBER'] || param['DEF_STRING'] || param['DEF_DATE']) ?
                    utils.coalesce(param['DEF_NUMBER'], param['DEF_STRING'], param['DEF_DATE']) : null,
                'Функция': param['SLINKED_FUNCTION'],
                'Параметр метода вызова': param['SM_PARAM']
            })
            paramsJson.push({
                'NAME': param['NAME'],
                'POSITION': param['POSITION'],
                'DOMAIN': param['SDOMAIN'],
                'LINK_TYPE': [
                    'Нет',
                    'Атрибут',
                    'Контекст',
                    'Значение',
                    'Результат функции',
                    'Параметр метода вызова'
                ][param['LINK_TYPE']],
                'LINK_ATTR': param['SLINK_ATTR'],
                'CONTEXT': param['CONTEXT'] !== null ? CONTEXTS[param['CONTEXT']] : null,
                'VALUE': (param['DEF_NUMBER'] || param['DEF_STRING'] || param['DEF_DATE']) ?
                    utils.coalesce(param['DEF_NUMBER'], param['DEF_STRING'], param['DEF_DATE']) : null,
                'LINKED_FUNCTION': param['SLINKED_FUNCTION'],
                'SHOW_METHOD_PARAM': param['SM_PARAM']
            })
        }
        return {
            'toml': nullEmptyArray(paramsToml),
            'json': paramsJson
        }
    }

    async _getActionMethodsMeta(actionRn, curPath) {
        let methodsToml = []
        let methodsJson = []
        const query = await this.oci.execute(`
            select T.RN,
                   F.CODE
              from DMSCLACTIONSMTH T,
                   DMSCLMETHODS    F
             where T.PRN = :A_ACTION
               and T.METHOD = F.RN
             order by F.CODE`,
            [actionRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const method = query.rows[i]
            const forms = await this._getFormsMeta(ACTION_FORM_KIND, null, method['RN'], 'DMSCLACTIONSMTH', path.posix.join(curPath, 'Methods', method['CODE']))
            methodsToml.push({
                'Метод': method['CODE'],
                'Формы': {
                    'Форма': forms.toml
                }
            })
            methodsJson.push({
                'CODE': method['CODE'],
                'FORMS': forms.json
            })
        }
        return {
            'toml': nullEmptyArray(methodsToml),
            'json': methodsJson
        }
    }

    async _getActionStepsMeta(actionRn, curPath) {
        const showParamsFolderName = 'StepsShowParams'
        let stepsToml = []
        let stepsJson = []
        const query = await this.oci.execute(`
            select T.RN,
                   T.POSITION,
                   T.STPTYPE,
                   P.NAME         as SEXEC_PARAM,
                   SM.UNITCODE    as SSHOWUNIT,
                   SM.METHOD_CODE as SSHOWMETHOD,
                   T.SHOWPARAMS,
                   T.SHOWKIND,
                   R.CODE         as SUSERREPORT,
                   UAM.CODE       as SUAMODULE,
                   UAMA.CODE      as SUAMODULE_ACTION
              from DMSCLACTIONSSTP  T,
                   DMSCLACTIONSPRM  P,
                   UNIT_SHOWMETHODS SM,
                   USERREPORTS      R,
                   UAMODULES        UAM,
                   UAMACTIONS       UAMA
             where T.PRN = :A_ACTION
               and T.EXEC_PARAM = P.RN(+)
               and T.SHOWMETHOD = SM.RN(+)
               and T.USERREPORT = R.RN(+)
               and T.UAMODULE = UAM.RN(+)
               and T.UAMODULE_ACTION = UAMA.RN(+)
             order by T.POSITION`,
            [actionRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const step = query.rows[i]
            if (step['SHOWPARAMS']) {
                await utils.saveClob1251Xml(step['SHOWPARAMS'],
                    path.posix.join(this.classDir, curPath, showParamsFolderName),
                    step['POSITION'] + '.xml')
            }
            stepsToml.push({
                'Позиция': step['POSITION'],
                'Тип': [
                    'Выполнить действие',
                    'Открыть раздел',
                    'Пользовательский отчет',
                    'Пользовательское приложение'][step['STPTYPE']],
                'Параметр действия': step['SEXEC_PARAM'],
                'Раздел': step['SSHOWUNIT'],
                'Метод вызова': step['SSHOWMETHOD'],
                'Параметры метода вызова': step['SHOWPARAMS'] ?
                    path.posix.join('.', curPath, showParamsFolderName, `${step['POSITION']}.xml`) : null,
                'Режим вызова': step['STPTYPE'] === 1 ? ['Обычный', 'Модальный', 'Как словарь'][step['SHOWKIND']] : null,
                'Пользовательский отчет': step['SUSERREPORT'],
                'Модуль пользовательского приложения': step['SUAMODULE'],
                'Действие модуля пользовательского приложения': step['SUAMODULE_ACTION']
            })
            stepsJson.push({
                'POSITION': step['POSITION'],
                'STEP_TYPE': [
                    'Выполнить действие',
                    'Открыть раздел',
                    'Пользовательский отчет',
                    'Пользовательское приложение'][step['STPTYPE']],
                'EXEC_ACTION_PARAM': step['SEXEC_PARAM'],
                'SHOWUNIT': step['SSHOWUNIT'],
                'SHOWMETHOD': step['SSHOWMETHOD'],
                'SHOWPARAMS': step['SHOWPARAMS'] ?
                    path.posix.join('.', curPath, showParamsFolderName, `${step['POSITION']}.xml`) : null,
                'SHOWKIND': step['STPTYPE'] === 1 ? ['Обычный', 'Модальный', 'Как словарь'][step['SHOWKIND']] : null,
                'USERREPORT': step['SUSERREPORT'],
                'UAMODULE': step['SUAMODULE'],
                'UAMODULE_ACTION': step['SUAMODULE_ACTION']
            })
        }
        return {
            'toml': nullEmptyArray(stepsToml),
            'json': stepsJson
        }
    }

    async _getObjectsMeta() {
        const OBJECT_TYPES = {
            0: {label: 'Таблица', extension: 'sql'},
            1: {label: 'Индекс', extension: 'sql'},
            2: {label: 'Триггер', extension: 'trg'},
            3: {label: 'Процедура', extension: 'prc'},
            4: {label: 'Функция', extension: 'fnc'},
            5: {label: 'Пакет', extension: 'pck'},
            6: {label: 'Пакет (тело)', extension: 'pkb'},
            7: {label: 'Представление', extension: 'vw'},
            8: {label: 'Последовательность', extension: 'sql'},
            9: {label: 'Внешние ключи', extension: 'sql'}
        }
        let objectsToml = []
        let objectsJson = []
        const query = await this.oci.execute(`
            select T.RN,
                   T.OBJTYPE,
                   T.NAME,
                   T.OBJKIND,
                   T.PLSQL_TEXT
              from DMSCLOBJECTS T
             where T.PRN = :WORKIN_CLASS
             order by T.NAME`,
            [this.classRn]
        )
        this._getMessage(this.R.objMeta)
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const obj = query.rows[i]
            const names = await this._getResources(obj['RN'], 'DMSCLOBJECTS', 'CAPTION')
            const objPath = 'Objects'
            const filename = `${obj['NAME']}.${OBJECT_TYPES[obj['OBJTYPE']].extension}`
            if (obj['PLSQL_TEXT']) {
                await utils.saveClob1251(obj['PLSQL_TEXT'], path.posix.join(this.classDir, objPath), filename)
            }
            objectsToml.push({
                'Тип': OBJECT_TYPES[obj['OBJTYPE']].label,
                'Имя': obj['NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Вид': ['Базовый', 'Клиентский', 'Полный клиентский'][obj['OBJKIND']],
                'Исходный текст': obj['PLSQL_TEXT'] ? path.posix.join('.', objPath, filename) : null
            })
            objectsJson.push({
                'OBJECT_TYPE': OBJECT_TYPES[obj['OBJTYPE']].label,
                'NAME': obj['NAME'],
                'COMMENT': names,
                'OBJECT_KIND': ['Базовый', 'Клиентский', 'Полный клиентский'][obj['OBJKIND']],
                'SOURCE': obj['PLSQL_TEXT'] ? path.posix.join('.', objPath, filename) : null
            })
        }
        return {
            'toml': nullEmptyArray(objectsToml),
            'json': objectsJson
        }
    }
}

// todo: extract options

module.exports = Extractor