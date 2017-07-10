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
        let className = ''
        if (this.language === 'ru') className = ' - ' + this.classInfo.RU
        if (this.language === 'uk') className = ' - ' + this.classInfo.UK
        utils.conE(`${this.R.procClass} ${this.classCode}${className}…`)
        this.dir = path.posix.normalize(dir)

        this.classDir = path.posix.join(this.dir, this.classInfo.path.replace('/', '/SubClasses/'))
        this.classRn = this.classInfo.rn
        const tomlContent = {
            'Используемые домены': {
                'Домен': await this._getDomainsMeta()
            },
            'Класс': await this._getClassMeta()
        }
        await utils.saveTextFile(tomlify(tomlContent, null, 4), this.classDir, 'Metadata.toml')
        return {
            classRn: this.classRn,
            classCode: this.classCode,
            classDir: this.classDir
        }
    }

    async _saveIcons(savePath, code) {
        let query = await this.oci.execute(
            ' select SY.*  from SYSIMAGES SY  where code = :CODE',
            [code]
        )
        let icon = query.rows[0]
        await utils.saveBlob(icon['SMALL_IMAGE'], savePath, `${icon['CODE']}_16.bmp`)
        await utils.saveBlob(icon['LARGE_IMAGE'], savePath, `${icon['CODE']}_24.bmp`)
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
        // utils.conU(this.R.classInfo)
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
        let domainsData = []
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
            let objDomain = {
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
                    {'Перечисляемое значение': await this._getDomainEnums(domain['RN'])}
                    : null
            }
            domainsData.push(objDomain)
        }
        return nullEmptyArray(domainsData)
    }

    async _getDomainEnums(domainRn) {
        let enums = []
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
            enums.push({
                'Позиция': enumRow['POSITION'].trim(),
                'Значение': utils.coalesce(enumRow['VALUE_STR'], enumRow['VALUE_NUM'], enumRow['VALUE_DATE']),
                'Наименование (RU)': enumName.RU,
                'Наименование (UK)': enumName.UK,
            })
        }
        return nullEmptyArray(enums)
    }

    async _getMetadataDomainList() {
        utils.conU(this.R.metaDomains)
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
        return query.rows.map((row) => {
            return row['CODE']
        })
    }

    async _getConditionDomainList() {
        utils.conU(this.R.condDomains)
        let query = await this.oci.execute(`
                select settings as SETTINGS
                  from UNIT_SHOWMETHODS
                 where PRN = :CLASSRN
                   and LENGTH(SETTINGS) > 0`,
            [this.classRn])
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
        utils.conU(this.R.classDef)
        let classQuery = await this.oci.execute(`
             select CL.*,
                    (select I.CODE from SYSIMAGES I where I.RN = CL.SYSIMAGE) as SSYSIMAGE,
                    UA.CODE as SDOCFORM
               from UNITLIST CL, UAMODULES UA
              where CL.RN = :CLASSRN
                and CL.DOCFORM = UA.RN(+)`,
            [this.classRn])
        let classRow = classQuery.rows[0]
        let names = await this._getResources(classRow['RN'], 'UNITLIST', 'UNITNAME')
        if (classRow['SSYSIMAGE']) {
            await this._saveIcons(this.classDir, classRow['SSYSIMAGE'])
        }
        return {
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
            'Таблица': classRow['TABLE_NAME'] ? await this._getTableMeta(classRow['TABLE_NAME']) : null,
            'Атрибуты': {
                'Атрибут': await this._getAttributesMeta()
            },
            'Ограничения': {
                'Ограничение': await this._getConstraintsMeta()
            },
            'Связи': {
                'Связь': await this._getLinksMeta()
            },
            'Представления': {
                'Представление': await this._getViewsMeta()
            },
            'Методы вызова': {
                'Метод вызова': await this._getShowMethodsMeta()
            },
            'Методы': {
                'Метод': await this._getMethodsMeta()
            },
            'Действия': {
                'Действие': await this._getActionsMeta()
            },
            'Объекты': {
                'Объект': await this._getObjectsMeta()
            }
        }
    }

    async _getFormsMeta(kind, showMethodRn, actionMethod, table, curPath) {

        const formDataName = 'Form.xml'
        const formEventsName = 'Events'
        const condDataName = 'ConditionForm.xml'
        const condEventsName = 'ConditionEvents'

        let forms = []
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
            forms.push({
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
                    'Приложение': await this._getFormApplications(formRecord['RN'])
                } : null,
                'Файл': formRecord['FORM_DATA'] ? path.posix.join('.', relPath, `${formRecord['FORM_LANGUAGE']}_${formDataName}`) : null
            })
        }
        return nullEmptyArray(forms)
    }

    async _getTableMeta(tableName) {
        utils.conU(this.R.tabDef)
        const query = await this.oci.execute(
            'select TL.* from TABLELIST TL where TL.TABLENAME = :TABLENAME',
            [tableName])
        const res = query.rows[0]
        const names = await this._getResources(res['RN'], 'TABLELIST', 'TABLENOTE')
        return {
            'Имя': res['TABLENAME'],
            'Наименование (RU)': names.RU,
            'Наименование (UK)': names.UK,
            'Тип информации': ['Постоянная', 'Временная'][res['TEMPFLAG']],
            'Технология производства': ['Стандарт', 'Конструктор'][res['TECHNOLOGY']]
        }
    }

    async _getAttributesMeta() {
        utils.conU(this.R.attrMeta)
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
        let attrs = []
        for (let i = 0, len = attrsQuery.rows.length; i < len; i++) {
            const attr = attrsQuery.rows[i]
            const names = await this._getResources(attr['RN'], 'DMSCLATTRS', 'CAPTION')
            attrs.push({
                'Имя': attr['COLUMN_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Позиция': attr['POSITION'],
                'Тип': ['Физический', 'Логический', 'Получен по связи'][attr['KIND']],
                'Домен': attr['SDOMAIN'],
                'Связь': attr['SREF_LINK'],
                'Атрибут связи': attr['SREF_ATTRIBUTE']
            })
        }
        return nullEmptyArray(attrs)
    }

    async _getConstraintsMeta() {
        const CONSTRAINT_TYPES = {
            0: 'Уникальность',
            1: 'Первичный ключ',
            2: 'Проверка',
            5: 'Обязательность',
            6: 'Неизменяемость'
        }
        utils.conU(this.R.consMeta)
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
        let constrs = []
        for (let i = 0, len = query.rows.length; i < len; i++) {
            const constr = query.rows[i]
            const names = await this._getResources(constr['RN'], 'DMSCLCONSTRS', 'CONSTRAINT_NOTE')
            const messages = await this._getResources(constr['MESSAGE'], 'DMSMESSAGES', 'TEXT')
            constrs.push({
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
                    'Атрибут': await this._getConstraintAttributesMeta(constr['RN'])
                }
            })
        }
        return nullEmptyArray(constrs)
    }

    async _getConstraintAttributesMeta(constrRn) {
        let query = await this.oci.execute(`
                        select T.POSITION, TR1.COLUMN_NAME
                          from DMSCLCONATTRS T, DMSCLATTRS TR1
                         where T.PRN = :A_CONS
                           and T.ATTRIBUTE = TR1.RN
                         order by TR1.COLUMN_NAME
                     `, [constrRn])
        return nullEmptyArray(query.rows.map((attr) => {
            return {
                'Позиция': attr['POSITION'],
                'Атрибут': attr['COLUMN_NAME']
            }
        }))
    }

    async _getLinksMeta() {
        let links = []
        utils.conU(this.R.linkMeta)
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
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const link = query.rows[i]
            const names = await this._getResources(link['RN'], 'DMSCLLINKS', 'CONSTRAINT_NOTE')
            links.push({
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
                    'Атрибут': await this._getLinkAttributesMeta(link['RN'])
                }
            })
        }
        return nullEmptyArray(links)
    }

    async _getLinkAttributesMeta(linkRn) {
        let attrs = []
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
            attrs.push({
                'Позиция': attr['POSITION'],
                'Атрибут класса-приемника': attr['SDESTINATION'],
                'Атрибут класса-источника': attr['SSOURCE']
            })
        }
        return nullEmptyArray(attrs)
    }

    async _getViewsMeta() {
        let views = []
        utils.conU(this.R.viewMeta)
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
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const view = query.rows[i]
            const names = await this._getResources(view['RN'], 'DMSCLVIEWS', 'VIEW_NOTE')
            views.push({
                'Имя': view['VIEW_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Тип': ['Представление', 'Запрос'][view['CUSTOM_QUERY']],
                'Вызывается с клиента': !!view['ACCESSIBILITY'],
                'Текст запроса': view['QUERY_SQL'],
                'Параметры': {
                    'Параметр': view['CUSTOM_QUERY'] ? await this._getViewParamsMeta(view['RN']) : null
                },
                'Атрибуты': {
                    'Атрибут': await this._getViewAttributesMeta(view['RN'])
                }
            })
        }
        return nullEmptyArray(views)
    }

    async _getViewParamsMeta(viewRn) {
        let params = []
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
            params.push({
                'Наименование параметра': param['PARAM_NAME'],
                'Домен': param['SDOMAIN']
            })
        }
        return nullEmptyArray(params)
    }

    async _getViewAttributesMeta(viewRn) {
        let attrs = []
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
            attrs.push({
                'Атрибут класса': attr['SATTR'],
                'Имя колонки': attr['COLUMN_NAME']
            })
        }
        return nullEmptyArray(attrs)
    }

    async _getMethodsMeta() {
        let methods = []
        utils.conU(this.R.metMeta)
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
        for (let i = 0, l = q.rows.length; i < l; i++) {
            const method = q.rows[i]
            const names = await
                this._getResources(method['RN'], 'DMSCLMETHODS', 'NOTE')
            const comments = await
                this._getResources(method['RN'], 'DMSCLMETHODS', 'COMMENT')
            methods.push({
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
                    'Параметр': await this._getMethodParamsMeta(method['RN'])
                }
            })
        }
        return nullEmptyArray(methods)
    }

    async _getMethodParamsMeta(methodRn) {
        let params = []
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
            params.push({
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
        }
        return nullEmptyArray(params)
    }

    async _getShowMethodsMeta() {
        const settingsFileName = 'Settings.xml'
        let showMethods = []
        utils.conU(this.R.shMetMeta)
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
            showMethods.push({
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
                    'Параметр': await this._getShowMethodParamsMeta(showMethod['RN'])
                },
                'Формы': {
                    'Форма': await this._getFormsMeta(SHOWMETHOD_FORM_KIND, showMethod['RN'], null, null, relpath)
                }
            })
        }
        return nullEmptyArray(showMethods)
    }

    async _getShowMethodParamsMeta(showMethodRn) {
        let params = []
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
            params.push({
                'Атрибут класса': param['COLUMN_NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Имя входного параметра': param['IN_CODE'],
                'Имя выходного параметра': param['OUT_CODE'],
                'Тип данных': ['Строка', 'Дата', 'Число'][param['DATA_TYPE']],
                'Прямой запрос': param['DIRECT_SQL'],
                'Обратный запрос': param['BACK_SQL']
            })
        }
        return nullEmptyArray(params)
    }

    async _getFormApplications(formRn) {
        let apps = []
        const query = await this.oci.execute(`
                        select FLA.APPCODE
                          from USERFORMLNKAPPS FLA
                         where FLA.PRN = :A_FORM_RN
                         order by FLA.APPCODE`,
            [formRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            apps.push({
                'Код': query.rows[i]['APPCODE']
            })
        }
        return nullEmptyArray(apps)
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
        let actions = []
        utils.conU(this.R.actMeta)
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
              order by UF.NUMB`,
            [this.classRn])
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const action = query.rows[i]
            const curPath = path.posix.join('Actions', action['CODE'])
            if (action['SSYSIMAGE']) {
                await this._saveIcons(path.posix.join(this.classDir, curPath), action['SSYSIMAGE'])
            }
            const names = await this._getResources(action['RN'], 'UNITFUNC', 'NAME')
            actions.push({
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
                    'Форма': await this._getFormsMeta(ACTION_FORM_KIND, null, action['RN'], 'UNITFUNC', curPath)
                },
                'Параметры': {
                    'Параметр': await this._getActionParamsMeta(action['RN'])
                },
                'Методы': {
                    'Метод': await this._getActionMethodsMeta(action['RN'], curPath)
                },
                'Шаги': {
                    'Шаг': await this._getActionStepsMeta(action['RN'], curPath)
                }
            })
        }
        return nullEmptyArray(actions)
    }

    async _getActionParamsMeta(actionRn) {
        let params = []
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
            params.push({
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
        }
        return nullEmptyArray(params)
    }

    async _getActionMethodsMeta(actionRn, curPath) {
        let methods = []
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
            methods.push({
                'Метод': method['CODE'],
                'Формы': {
                    'Форма': await this._getFormsMeta(ACTION_FORM_KIND, null, method['RN'], 'DMSCLACTIONSMTH', path.posix.join(curPath, 'Methods', method['CODE']))
                }
            })
        }
        return nullEmptyArray(methods)
    }

    async _getActionStepsMeta(actionRn, curPath) {
        const showParamsFolderName = 'StepsShowParams'
        let steps = []
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
            steps.push({
                'Позиция': step['POSITION'],
                'Тип': [
                    'Выполнить действие',
                    'Открыть раздел',
                    'Пользовательский отчет',
                    'Пользовательское приложение'][step['STPTYPE']],
                'Параметр действия': step['SEXEC_PARAM'],
                'Раздел': steps['SSHOWUNIT'],
                'Метод вызова': step['SSHOWMETHOD'],
                'Параметры метода вызова': step['SHOWPARAMS'] ?
                    path.posix.join('.', curPath, showParamsFolderName, `${step['POSITION']}.xml`) : null,
                'Режим вызова': step['STPTYPE'] === 1 ? ['Обычный', 'Модальный', 'Как словарь'][step['SHOWKIND']] : null,
                'Пользовательский отчет': step['SUSERREPORT'],
                'Модуль пользовательского приложения': step['SUAMODULE'],
                'Действие модуля пользовательского приложения': step['SUAMODULE_ACTION']
            })
        }
        return nullEmptyArray(steps)
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
        let objects = []
        utils.conU(this.R.objMeta)
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
        for (let i = 0, l = query.rows.length; i < l; i++) {
            const obj = query.rows[i]
            const names = await this._getResources(obj['RN'], 'DMSCLOBJECTS', 'CAPTION')
            const objPath = 'Objects'
            const filename = `${obj['NAME']}.${OBJECT_TYPES[obj['OBJTYPE']].extension}`
            if (obj['PLSQL_TEXT']) {
                await utils.saveClob1251(obj['PLSQL_TEXT'], path.posix.join(this.classDir, objPath), filename)
            }
            objects.push({
                'Тип': OBJECT_TYPES[obj['OBJTYPE']].label,
                'Имя': obj['NAME'],
                'Наименование (RU)': names.RU,
                'Наименование (UK)': names.UK,
                'Вид': ['Базовый', 'Клиентский', 'Полный клиентский'][obj['OBJKIND']],
                'Исходный текст': obj['PLSQL_TEXT'] ? path.posix.join('.', objPath, filename) : null
            })
        }
        return nullEmptyArray(objects)
    }
}

// todo: extract options

module.exports = Extractor